// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

// Cria a instância do Express
const app = express();

// Serve todos os arquivos estáticos (HTML, CSS, JS, fontes, etc.) da pasta atual
app.use(express.static(__dirname));

// Cria o servidor HTTP
const server = http.createServer(app);

// Cria o WebSocket Server a partir do servidor HTTP
const wss = new WebSocket.Server({ server });

// Lista de conexões
let clients = [];

// Palavras banidas (filtro simples, pode ser melhorado)
const bannedWords = ['racista', 'pedofilo', 'sexo'];

// === Funções de Utilidade ===

// Substitui palavras banidas por '***'
function filterBadWords(text) {
  let sanitizedText = text;
  bannedWords.forEach((word) => {
    // Regex para substituir a palavra, ignorando maiúsculas/minúsculas
    const regex = new RegExp(word, 'gi');
    sanitizedText = sanitizedText.replace(regex, '***');
  });
  return sanitizedText;
}

// Formata *texto* como <i>texto</i> e **texto** como <b>texto</b>
function parseFormatting(text) {
  // **texto** (negrito)
  let formatted = text.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
  // *texto* (itálico)
  formatted = formatted.replace(/\*(.*?)\*/g, '<i>$1</i>');
  return formatted;
}

// Detecta links (http/https) e transforma em <a> clicável
function parseLinks(text) {
  // Regex simples para http:// ou https://
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.replace(urlRegex, (url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });
}

// Destaca menções do tipo @usuario
function parseMentions(text, clientList) {
  // Regex para capturar @username
  const mentionRegex = /@([a-zA-Z0-9_-]+)/g;

  return text.replace(mentionRegex, (match, p1) => {
    // Verifica se o usuário existe na lista
    const mentionedUser = clientList.find(
      (client) => client.username.toLowerCase() === p1.toLowerCase()
    );
    if (mentionedUser) {
      return `<span class="mention">@${mentionedUser.username}</span>`;
    }
    // Se não existir, mantém como estava
    return match;
  });
}

// Monta HTML final do texto (filtro + parse)
function formatMessage(rawText, clientList) {
  let sanitized = filterBadWords(rawText);
  sanitized = parseFormatting(sanitized);
  sanitized = parseLinks(sanitized);
  sanitized = parseMentions(sanitized, clientList);
  return sanitized;
}

// Broadcast para todos
function broadcast(data) {
  clients.forEach((client) => {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(data));
    }
  });
}

// Função para enviar mensagem apenas para um cliente específico
function sendToClient(targetClient, data) {
  if (targetClient.ws.readyState === WebSocket.OPEN) {
    targetClient.ws.send(JSON.stringify(data));
  }
}

// === Comandos ===

function handleCommand(client, command, args) {
  switch (command.toLowerCase()) {
    // Exibe a lista de comandos
    case '+help':
      const helpText = `
        <b>Lista de Comandos Disponíveis:</b><br>
        <ul>
          <li><b>+help</b>: Exibe esta lista de comandos</li>
          <li><b>+nick nome</b>: Altera seu nome de usuário</li>
          <li><b>+private_msg @usuario mensagem</b>: Envia mensagem privada para @usuario</li>
          <li><b>+clear_msg</b>: Limpa o histórico do chat (para todos)</li>
          <li><b>*texto*</b>: Formata <i>texto</i></li>
          <li><b>**texto**</b>: Formata <b>texto</b></li>
          <li>Links (http:// ou https://) são clicáveis</li>
          <li>Menções @usuario destacam o usuário</li>
        </ul>
      `;
      sendToClient(client, {
        type: 'system',
        message: helpText
      });
      break;

    // Mudar nome
    case '+nick':
      if (!args[0]) {
        sendToClient(client, {
          type: 'system',
          message: 'Uso: +nick <novoNome>'
        });
        return;
      }
      const oldName = client.username;
      const newName = filterBadWords(args[0]).trim();
      // Evita nomes vazios ou censurados
      if (!newName || newName === '***') {
        sendToClient(client, {
          type: 'system',
          message: 'Nome inválido.'
        });
        return;
      }
      client.username = newName;
      broadcast({
        type: 'system',
        message: `<b>${oldName}</b> agora é <b>${newName}</b>.`
      });
      break;

    // Mensagem privada
    case '+private_msg':
      // Esperamos algo como: +private_msg @fulano Mensagem
      // args[0] = @fulano
      // args[1..] = Mensagem
      if (!args[0] || !args[1]) {
        sendToClient(client, {
          type: 'system',
          message: 'Uso: +private_msg @usuario Mensagem'
        });
        return;
      }
      if (!args[0].startsWith('@')) {
        sendToClient(client, {
          type: 'system',
          message: 'Você precisa mencionar alguém. Ex: @fulano'
        });
        return;
      }
      const targetUsername = args[0].substring(1).toLowerCase();
      const targetClient = clients.find(
        (c) => c.username.toLowerCase() === targetUsername
      );
      if (!targetClient) {
        sendToClient(client, {
          type: 'system',
          message: `Usuário ${args[0]} não encontrado.`
        });
        return;
      }
      const privateMessage = args.slice(1).join(' ');
      const formattedPM = formatMessage(privateMessage, clients);
      // Envia para o remetente
      sendToClient(client, {
        type: 'private',
        from: client.username,
        to: targetClient.username,
        message: `(Para @${targetClient.username}) ${formattedPM}`
      });
      // Envia para o destinatário
      sendToClient(targetClient, {
        type: 'private',
        from: client.username,
        to: targetClient.username,
        message: `(De @${client.username}) ${formattedPM}`
      });
      break;

    // Limpar chat (para todos)
    case '+clear_msg':
      broadcast({
        type: 'clear'
      });
      broadcast({
        type: 'system',
        message: `<b>${client.username}</b> limpou o chat.`
      });
      break;

    default:
      sendToClient(client, {
        type: 'system',
        message: 'Comando não reconhecido. Use +help para ver a lista de comandos.'
      });
      break;
  }
}

// === Evento de Conexão WebSocket ===

wss.on('connection', (ws) => {
  // Cria um objeto cliente para armazenar dados
  const client = {
    ws,
    username: 'Anônimo'
  };

  // Adiciona o cliente à lista
  clients.push(client);

  ws.on('message', (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (error) {
      console.error('Erro ao fazer parse da mensagem:', error);
      return;
    }

    // data: { type: 'message' | 'command', message: '', username: '' }
    if (data.type === 'connect') {
      // Quando o usuário entra com seu username
      client.username = filterBadWords(data.username) || 'Anônimo';
      broadcast({
        type: 'system',
        message: `<b>${client.username}</b> entrou no chat.`
      });
    } else if (data.type === 'message') {
      const rawText = data.message || '';
      const trimmedText = rawText.trim();

      // Verifica se é um comando (inicia com +)
      if (trimmedText.startsWith('+')) {
        const parts = trimmedText.split(' ');
        const command = parts[0]; // ex: +help
        const args = parts.slice(1); // resto
        handleCommand(client, command, args);
      } else {
        // Mensagem normal
        const formatted = formatMessage(trimmedText, clients);
        broadcast({
          type: 'message',
          username: client.username,
          message: formatted
        });
      }
    }
  });

  ws.on('close', () => {
    // Remove o cliente da lista
    clients = clients.filter((c) => c !== client);

    broadcast({
      type: 'system',
      message: `<b>${client.username}</b> saiu do chat.`
    });
  });
});

// Inicia o servidor
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
