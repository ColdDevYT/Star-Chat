// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

// Cria a instância do Express
const app = express();

// Serve todos os arquivos estáticos da pasta atual
app.use(express.static(__dirname));

// Cria o servidor HTTP
const server = http.createServer(app);

// Cria o WebSocket Server a partir do servidor HTTP
const wss = new WebSocket.Server({ server });

// Lista de conexões
let clients = [];

// Listas de administração e penalidades
let admins = []; // Lista de usernames administradores
let bannedUsers = []; // Lista de usernames banidos
let mutedUsers = []; // Lista de usernames mutados

// Palavra(s) chave para autenticação de admin (Defina uma senha segura)
const ADMIN_PASSWORD = '92-033-192'; 

const bannedWords = ['racista', 'pedofilo', 'sexo', 'porra', 'puta', 'caralho', 'prr', 'fdp', 'foda', 'fds', 'vsfd', 'vagabundo', 'vagabun', 'vadia', 'vadi', 'pau', 'cu', 'bct', 'buceta' ]; // Palavras banidas

// === Funções de Utilidade ===

// Substitui palavras banidas por '***'
function filterBadWords(text) {
  let sanitizedText = text;
  bannedWords.forEach((word) => {
    const regex = new RegExp(word, 'gi');
    sanitizedText = sanitizedText.replace(regex, '***');
  });
  return sanitizedText;
}

// Formata *texto* como <i>texto</i> e **texto** como <b>texto</b>
function parseFormatting(text) {
  let formatted = text.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
  formatted = formatted.replace(/\*(.*?)\*/g, '<i>$1</i>');
  return formatted;
}

// Detecta links (http/https) e transforma em <a> clicável
function parseLinks(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.replace(urlRegex, (url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });
}

// Destaca menções do tipo @usuario
function parseMentions(text, clientList) {
  const mentionRegex = /@([a-zA-Z0-9_-]+)/g;

  return text.replace(mentionRegex, (match, p1) => {
    const mentionedUser = clientList.find(
      (client) => client.username.toLowerCase() === p1.toLowerCase()
    );
    if (mentionedUser) {
      return `<span class="mention">@${mentionedUser.username}</span>`;
    }
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

// Envia mensagem apenas para um cliente específico
function sendToClient(targetClient, data) {
  if (targetClient.ws.readyState === WebSocket.OPEN) {
    targetClient.ws.send(JSON.stringify(data));
  }
}

// Verifica se um usuário é administrador
function isAdmin(username) {
  return admins.includes(username.toLowerCase());
}

// === Comandos ===

function handleCommand(client, command, args) {
  switch (command.toLowerCase()) {
    case '+help':
      const helpText = `
        <b>Lista de Comandos Disponíveis:</b><br>
        <ul>
          <li><b>+help</b>: Exibe esta lista de comandos</li>
          <li><b>+nick nome</b>: Altera seu nome de usuário</li>
          <li><b>+private_msg @usuario mensagem</b>: Envia mensagem privada para @usuario</li>
          <li><b>+clear_msg</b>: Limpa o histórico do chat (para todos)</li>
          <li><b>+mute @usuario</b>: Muta um usuário (Admin)</li>
          <li><b>+unmute @usuario</b>: Desmuta um usuário (Admin)</li>
          <li><b>+ban @usuario</b>: Bane um usuário (Admin)</li>
          <li><b>+unban @usuario</b>: Desbane um usuário (Admin)</li>
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

    case '+mute':
      if (!isAdmin(client.username)) {
        sendToClient(client, {
          type: 'system',
          message: 'Você não tem permissão para executar este comando.'
        });
        return;
      }
      if (!args[0]) {
        sendToClient(client, {
          type: 'system',
          message: 'Uso: +mute @usuario'
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
      const muteUsername = args[0].substring(1).toLowerCase();
      if (mutedUsers.includes(muteUsername)) {
        sendToClient(client, {
          type: 'system',
          message: `Usuário @${muteUsername} já está mutado.`
        });
        return;
      }
      mutedUsers.push(muteUsername);
      broadcast({
        type: 'system',
        message: `<b>${client.username}</b> mutou <b>@${muteUsername}</b>.`
      });
      break;

    case '+unmute':
      if (!isAdmin(client.username)) {
        sendToClient(client, {
          type: 'system',
          message: 'Você não tem permissão para executar este comando.'
        });
        return;
      }
      if (!args[0]) {
        sendToClient(client, {
          type: 'system',
          message: 'Uso: +unmute @usuario'
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
      const unmuteUsername = args[0].substring(1).toLowerCase();
      if (!mutedUsers.includes(unmuteUsername)) {
        sendToClient(client, {
          type: 'system',
          message: `Usuário @${unmuteUsername} não está mutado.`
        });
        return;
      }
      mutedUsers = mutedUsers.filter((u) => u !== unmuteUsername);
      broadcast({
        type: 'system',
        message: `<b>${client.username}</b> desmuta <b>@${unmuteUsername}</b>.`
      });
      break;

    case '+ban':
      if (!isAdmin(client.username)) {
        sendToClient(client, {
          type: 'system',
          message: 'Você não tem permissão para executar este comando.'
        });
        return;
      }
      if (!args[0]) {
        sendToClient(client, {
          type: 'system',
          message: 'Uso: +ban @usuario'
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
      const banUsername = args[0].substring(1).toLowerCase();
      if (bannedUsers.includes(banUsername)) {
        sendToClient(client, {
          type: 'system',
          message: `Usuário @${banUsername} já está banido.`
        });
        return;
      }
      bannedUsers.push(banUsername);
      // Encontra o cliente banido e o desconecta
      const targetBanClient = clients.find(
        (c) => c.username.toLowerCase() === banUsername
      );
      if (targetBanClient) {
        sendToClient(targetBanClient, {
          type: 'system',
          message: 'Você foi banido do chat.'
        });
        targetBanClient.ws.close();
      }
      broadcast({
        type: 'system',
        message: `<b>${client.username}</b> baniu <b>@${banUsername}</b>.`
      });
      break;

    case '+unban':
      if (!isAdmin(client.username)) {
        sendToClient(client, {
          type: 'system',
          message: 'Você não tem permissão para executar este comando.'
        });
        return;
      }
      if (!args[0]) {
        sendToClient(client, {
          type: 'system',
          message: 'Uso: +unban @usuario'
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
      const unbanUsername = args[0].substring(1).toLowerCase();
      if (!bannedUsers.includes(unbanUsername)) {
        sendToClient(client, {
          type: 'system',
          message: `Usuário @${unbanUsername} não está banido.`
        });
        return;
      }
      bannedUsers = bannedUsers.filter((u) => u !== unbanUsername);
      broadcast({
        type: 'system',
        message: `<b>${client.username}</b> desbaniu <b>@${unbanUsername}</b>.`
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

    // data: { type: 'connect' | 'admin_auth' | 'message', ... }
    if (data.type === 'connect') {
      // Quando o usuário entra com seu username
      const desiredUsername = data.username.toLowerCase();

      // Verifica se o usuário está banido
      if (bannedUsers.includes(desiredUsername)) {
        sendToClient(client, {
          type: 'system',
          message: 'Você está banido do chat.'
        });
        ws.close();
        return;
      }

      client.username = filterBadWords(data.username) || 'Anônimo';
      broadcast({
        type: 'system',
        message: `<b>${client.username}</b> entrou no chat.`
      });
    } else if (data.type === 'admin_auth') {
      // Autenticação de administrador
      const password = data.password;
      if (password === ADMIN_PASSWORD) {
        admins.push(client.username.toLowerCase());
        sendToClient(client, {
          type: 'system',
          message: 'Autenticado como administrador.'
        });
        broadcast({
          type: 'system',
          message: `<b>${client.username}</b> foi autenticado como administrador.`
        });
      } else {
        sendToClient(client, {
          type: 'system',
          message: 'Senha de administrador incorreta.'
        });
      }
    } else if (data.type === 'add_admin') {
      // Adiciona um administrador (Somente admin pode adicionar)
      if (!isAdmin(client.username)) {
        sendToClient(client, {
          type: 'system',
          message: 'Você não tem permissão para executar esta ação.'
        });
        return;
      }
      const newAdmin = data.new_admin.toLowerCase();
      if (admins.includes(newAdmin)) {
        sendToClient(client, {
          type: 'system',
          message: `Usuário @${newAdmin} já é um administrador.`
        });
        return;
      }
      admins.push(newAdmin);
      broadcast({
        type: 'system',
        message: `<b>${client.username}</b> adicionou <b>@${newAdmin}</b> como administrador.`
      });
    } else if (data.type === 'message') {
      const rawText = data.message || '';
      const trimmedText = rawText.trim();

      // Verifica se o usuário está mutado
      if (mutedUsers.includes(client.username.toLowerCase())) {
        sendToClient(client, {
          type: 'system',
          message: 'Você está mutado e não pode enviar mensagens.'
        });
        return;
      }

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

    // Se for admin, remove da lista de admins
    const indexAdmin = admins.indexOf(client.username.toLowerCase());
    if (indexAdmin !== -1) {
      admins.splice(indexAdmin, 1);
    }

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
