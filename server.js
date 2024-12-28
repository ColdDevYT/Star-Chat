// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ===========================
//     CONFIGURAÇÕES BÁSICAS
// ===========================

// Serve arquivos estáticos (HTML, CSS, JS, fontes, etc.)
app.use(express.static(__dirname));

// Lista de usuários conectados
let clients = [];

// Lista de admins (strings de nomes de usuário).
// Pode ser populado dinamicamente pelo control_adm.html
let admins = [];

// Lista de usuários banidos
let bannedUsers = []; // armazena nicks banidos

// Palavras banidas (filtro simples)
const bannedWords = ['racista', 'pedofilo', 'sexo'];

// ===========================
//       FUNÇÕES DE APOIO
// ===========================

// Aplica filtro de palavras banidas
function filterBadWords(text) {
  let sanitizedText = text;
  bannedWords.forEach((word) => {
    const regex = new RegExp(word, 'gi');
    sanitizedText = sanitizedText.replace(regex, '***');
  });
  return sanitizedText;
}

// Formatação *italico* e **negrito**
function parseFormatting(text) {
  let formatted = text.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');   // **texto** -> <b>texto</b>
  formatted = formatted.replace(/\*(.*?)\*/g, '<i>$1</i>');      // *texto*  -> <i>texto</i>
  return formatted;
}

// Transforma URLs em links clicáveis
function parseLinks(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.replace(urlRegex, (url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });
}

// Destaca menções @nome
function parseMentions(text, clientList) {
  const mentionRegex = /@([a-zA-Z0-9_-]+)/g;
  return text.replace(mentionRegex, (match, p1) => {
    const mentionedUser = clientList.find(
      (client) => client.username.toLowerCase() === p1.toLowerCase()
    );
    if (mentionedUser) {
      return `<span class="mention">@${mentionedUser.username}</span>`;
    }
    return match; // se não achar, mantém
  });
}

// Aplica todos os filtros e formatações
function formatMessage(rawText, clientList) {
  let sanitized = filterBadWords(rawText);
  sanitized = parseFormatting(sanitized);
  sanitized = parseLinks(sanitized);
  sanitized = parseMentions(sanitized, clientList);
  return sanitized;
}

// Envia mensagem para todos
function broadcast(data) {
  clients.forEach((client) => {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(data));
    }
  });
}

// Envia mensagem para um cliente específico
function sendToClient(targetClient, data) {
  if (targetClient.ws.readyState === WebSocket.OPEN) {
    targetClient.ws.send(JSON.stringify(data));
  }
}

// Verifica se um usuário é admin
function isAdmin(username) {
  return admins.some((adm) => adm.toLowerCase() === username.toLowerCase());
}

// Localiza cliente pelo nome
function findClientByName(username) {
  return clients.find(
    (c) => c.username.toLowerCase() === username.toLowerCase()
  );
}

// Fecha a conexão de um usuário
function disconnectUser(client) {
  try {
    client.ws.close();
  } catch (err) {
    console.error('Erro ao desconectar usuário:', err);
  }
}

// ===========================
//       COMANDOS
// ===========================
function handleCommand(client, command, args) {
  // Verifica se é admin
  const userIsAdmin = isAdmin(client.username);

  switch (command.toLowerCase()) {
    case '+help':
      const helpText = `
        <b>Comandos Disponíveis:</b><br>
        <ul>
          <li><b>+help</b>: Lista de comandos</li>
          <li><b>+nick &lt;novoNome&gt;</b>: Altera seu nome de usuário</li>
          <li><b>+private_msg @usuario mensagem</b>: Envia mensagem privada</li>
          <li><b>+clear_msg</b>: Limpa o histórico do chat (para todos)</li>
          <li><b>*texto*</b>: Formata <i>texto</i></li>
          <li><b>**texto**</b>: Formata <b>texto</b></li>
          <li>Links (http:// ou https://) são clicáveis</li>
          <li>Menções @usuario destacam o usuário</li>
          ${
            userIsAdmin
              ? `
              <li><b>+ban &lt;usuario&gt;</b> / <b>+unban &lt;usuario&gt;</b></li>
              <li><b>+mute &lt;usuario&gt;</b> / <b>+unmute &lt;usuario&gt;</b></li>
              `
              : ''
          }
        </ul>
      `;
      sendToClient(client, { type: 'system', message: helpText });
      break;

    case '+nick':
      if (!args[0]) {
        sendToClient(client, { type: 'system', message: 'Uso: +nick <novoNome>' });
        return;
      }
      const oldName = client.username;
      const newName = filterBadWords(args[0]).trim();
      if (!newName || newName === '***') {
        sendToClient(client, { type: 'system', message: 'Nome inválido.' });
        return;
      }
      // Se o user era admin e mudou de nome, precisamos verificar se sai da admin list
      // (depende da sua lógica; aqui, o user "perde" o admin se mudar de nome, a menos que readicione)
      if (isAdmin(oldName)) {
        admins = admins.filter((adm) => adm.toLowerCase() !== oldName.toLowerCase());
      }

      client.username = newName;
      broadcast({
        type: 'system',
        message: `<b>${oldName}</b> agora é <b>${newName}</b>.`
      });
      break;

    case '+private_msg':
      if (!args[0] || !args[1]) {
        sendToClient(client, {
          type: 'system',
          message: 'Uso: +private_msg @usuario Mensagem'
        });
        return;
      }
      if (!args[0].startsWith('@')) {
        sendToClient(client, { type: 'system', message: 'Mencione alguém. Ex: @fulano' });
        return;
      }
      const targetUsername = args[0].substring(1);
      const targetClient = findClientByName(targetUsername);
      if (!targetClient) {
        sendToClient(client, {
          type: 'system',
          message: `Usuário ${args[0]} não encontrado.`
        });
        return;
      }
      if (targetClient.isBanned) {
        sendToClient(client, {
          type: 'system',
          message: `Este usuário está banido.`
        });
        return;
      }
      const privateMsg = args.slice(1).join(' ');
      const formattedPM = formatMessage(privateMsg, clients);
      // Envia ao remetente
      sendToClient(client, {
        type: 'private',
        from: client.username,
        to: targetClient.username,
        message: `(Para @${targetClient.username}) ${formattedPM}`
      });
      // Envia ao destinatário
      sendToClient(targetClient, {
        type: 'private',
        from: client.username,
        to: targetClient.username,
        message: `(De @${client.username}) ${formattedPM}`
      });
      break;

    case '+clear_msg':
      broadcast({ type: 'clear' });
      broadcast({
        type: 'system',
        message: `<b>${client.username}</b> limpou o chat.`
      });
      break;

    // ======= COMANDOS DE ADMIN =======
    case '+ban':
      if (!userIsAdmin) {
        sendToClient(client, { type: 'system', message: 'Acesso negado.' });
        return;
      }
      if (!args[0]) {
        sendToClient(client, { type: 'system', message: 'Uso: +ban <usuario>' });
        return;
      }
      {
        const banName = args[0];
        if (bannedUsers.includes(banName.toLowerCase())) {
          sendToClient(client, { type: 'system', message: 'Usuário já está banido.' });
          return;
        }
        bannedUsers.push(banName.toLowerCase());
        broadcast({ type: 'system', message: `<b>${banName}</b> foi banido do chat.` });
        // Tenta desconectar se estiver online
        const banClient = findClientByName(banName);
        if (banClient) {
          banClient.isBanned = true;
          disconnectUser(banClient);
        }
      }
      break;

    case '+unban':
      if (!userIsAdmin) {
        sendToClient(client, { type: 'system', message: 'Acesso negado.' });
        return;
      }
      if (!args[0]) {
        sendToClient(client, { type: 'system', message: 'Uso: +unban <usuario>' });
        return;
      }
      {
        const unbanName = args[0].toLowerCase();
        bannedUsers = bannedUsers.filter((u) => u !== unbanName);
        broadcast({ type: 'system', message: `<b>${args[0]}</b> foi desbanido do chat.` });
      }
      break;

    case '+mute':
      if (!userIsAdmin) {
        sendToClient(client, { type: 'system', message: 'Acesso negado.' });
        return;
      }
      if (!args[0]) {
        sendToClient(client, { type: 'system', message: 'Uso: +mute <usuario>' });
        return;
      }
      {
        const muteClient = findClientByName(args[0]);
        if (!muteClient) {
          sendToClient(client, { type: 'system', message: 'Usuário não encontrado.' });
          return;
        }
        if (muteClient.isMuted) {
          sendToClient(client, { type: 'system', message: 'Usuário já está mutado.' });
          return;
        }
        muteClient.isMuted = true;
        broadcast({ type: 'system', message: `<b>${muteClient.username}</b> foi mutado.` });
      }
      break;

    case '+unmute':
      if (!userIsAdmin) {
        sendToClient(client, { type: 'system', message: 'Acesso negado.' });
        return;
      }
      if (!args[0]) {
        sendToClient(client, { type: 'system', message: 'Uso: +unmute <usuario>' });
        return;
      }
      {
        const unmuteClient = findClientByName(args[0]);
        if (!unmuteClient) {
          sendToClient(client, { type: 'system', message: 'Usuário não encontrado.' });
          return;
        }
        unmuteClient.isMuted = false;
        broadcast({ type: 'system', message: `<b>${unmuteClient.username}</b> foi desmutado.` });
      }
      break;

    default:
      sendToClient(client, {
        type: 'system',
        message: 'Comando não reconhecido. Use +help para ver a lista de comandos.'
      });
      break;
  }
}

// ===========================
//     EVENTOS WEBSOCKET
// ===========================
wss.on('connection', (ws) => {
  // Cria objeto para o usuário
  const client = {
    ws,
    username: 'Anônimo',
    isBanned: false,
    isMuted: false
  };

  clients.push(client);

  ws.on('message', (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch (err) {
      console.error('Erro ao parse da mensagem:', err);
      return;
    }

    if (data.type === 'connect') {
      // Quando usuário conecta, definimos nome e avatar (se houver)
      let sanitizedUsername = filterBadWords(data.username || 'Anônimo');
      // Verifica se está banido
      if (bannedUsers.includes(sanitizedUsername.toLowerCase())) {
        // desconecta imediatamente
        ws.send(JSON.stringify({
          type: 'system',
          message: 'Você está banido do chat.'
        }));
        ws.close();
        return;
      }

      client.username = sanitizedUsername;
      // Se ele mudar o nome para algo que está banido no meio do caminho...
      if (bannedUsers.includes(client.username.toLowerCase())) {
        ws.send(JSON.stringify({
          type: 'system',
          message: 'Você está banido do chat.'
        }));
        ws.close();
        return;
      }

      broadcast({
        type: 'system',
        message: `<b>${client.username}</b> entrou no chat.`
      });
    } else if (data.type === 'message') {
      // Se o usuário está banido ou se baniu depois de conectado
      if (bannedUsers.includes(client.username.toLowerCase())) {
        ws.send(JSON.stringify({
          type: 'system',
          message: 'Você está banido do chat.'
        }));
        ws.close();
        return;
      }

      // Se o usuário está mutado, ignora a mensagem
      if (client.isMuted) {
        sendToClient(client, {
          type: 'system',
          message: 'Você está mutado e não pode enviar mensagens.'
        });
        return;
      }

      const rawText = data.message || '';
      const trimmedText = rawText.trim();

      // Verifica se é comando
      if (trimmedText.startsWith('+')) {
        const parts = trimmedText.split(' ');
        const command = parts[0];
        const args = parts.slice(1);
        handleCommand(client, command, args);
      } else {
        // Mensagem comum
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
    clients = clients.filter((c) => c !== client);
    broadcast({
      type: 'system',
      message: `<b>${client.username}</b> saiu do chat.`
    });
  });
});

// ===========================
//   ROTA PARA O CONTROL_ADM
// ===========================

// A ideia é proteger essa rota com uma senha simples na query string
// Exemplo: https://seusite.com/control_adm.html?admin_pass=SUA_SENHA
const ADMIN_PASS = '92-033-192'; // Troque para uma senha segura!

app.get('/control_adm.html', (req, res, next) => {
  const pass = req.query.admin_pass;
  // Verifica se a senha é válida
  if (pass !== ADMIN_PASS) {
    // Se não for, retorna 403 (Forbidden)
    return res.status(403).send('<h1>Acesso Negado</h1>');
  }
  // Se for válida, serve o arquivo
  res.sendFile(__dirname + '/control_adm.html');
});

// ===========================
//   INICIANDO O SERVIDOR
// ===========================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
