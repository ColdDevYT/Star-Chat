// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ======================
//  CONFIG / VARIÁVEIS
// ======================
app.use(express.static(__dirname)); // serve arquivos estáticos
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ADMIN_PASS = '1234'; // senha do painel admin

// Lista de admins
let admins = [];

// Lista de usuários banidos (nick)
let bannedUsers = [];

// Palavras banidas
const bannedWords = ['racista', 'pedofilo', 'sexo'];

// Memória de logs (máximo 100 registros)
let messageLogs = [];

// Relatórios (report) armazenados para admin
let reports = [];

// Rate limit: max 5 mensagens em 10 segundos
const MAX_MESSAGES = 5;
const TIME_WINDOW_MS = 10000;

// ======================
//    MODELOS
// ======================
// Representa um usuário conectado
/*
  client = {
    ws,                // WebSocket
    userID,            // ID único gerado
    username,          // nome exibido
    room,              // sala atual
    isMuted,           // boolean
    isBanned,          // boolean
    isAFK,             // boolean
    avatar,            // URL ou base64 do avatar
    lastMessages: [],  // timestamps das últimas mensagens (para rate limit)
  }
*/

// Coleção de todos os usuários conectados
let clients = [];

// ======================
//    FUNÇÕES AUX
// ======================

// Gera um userID único simples
function generateUserID() {
  return 'user-' + Math.random().toString(36).substring(2, 9);
}

function isAdmin(username) {
  return admins.some(a => a.toLowerCase() === username.toLowerCase());
}

function findClientByName(nick) {
  return clients.find(c => c.username.toLowerCase() === nick.toLowerCase());
}

// Verifica se usuário está banido
function isUserBanned(nick) {
  return bannedUsers.includes(nick.toLowerCase());
}

// Desconecta forçado
function disconnectUser(client) {
  try { client.ws.close(); } catch(e) { /* noop */ }
}

// Filtra palavrões
function filterBadWords(text) {
  let s = text;
  bannedWords.forEach(word => {
    const regex = new RegExp(word, 'gi');
    s = s.replace(regex, '***');
  });
  return s;
}

// Formata *texto* => <i>texto</i> e **texto** => <b>texto</b>
function parseFormatting(text) {
  let t = text.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
  t = t.replace(/\*(.*?)\*/g, '<i>$1</i>');
  return t;
}

// Links clicáveis
function parseLinks(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.replace(urlRegex, (url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });
}

// Menções + AFK check
function parseMentions(text, sender) {
  // Formato: @nick
  const mentionRegex = /@([a-zA-Z0-9_-]+)/g;
  return text.replace(mentionRegex, (match, p1) => {
    const targetClient = findClientByName(p1);
    if (targetClient) {
      // Se está AFK, avisa o sender
      if (targetClient.isAFK && sender) {
        sendToClient(sender, {
          type: 'system',
          message: `<b>${targetClient.username}</b> está AFK no momento.`
        });
      }
      return `<span class="mention">@${targetClient.username}</span>`;
    }
    return match;
  });
}

// Aplica todos os parses
function formatMessage(text, sender) {
  let s = filterBadWords(text);
  s = parseFormatting(s);
  s = parseLinks(s);
  s = parseMentions(s, sender);
  return s;
}

// Loga uma mensagem no histórico
function logMessage(data) {
  // data: { type, room, username, message, timestamp }
  messageLogs.push(data);
  // Limita a 100 mensagens
  if (messageLogs.length > 100) {
    messageLogs.shift();
  }
}

// Envia para 1 cliente
function sendToClient(client, data) {
  if (client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(data));
  }
}

// Envia para todos de uma sala
function broadcast(roomName, data) {
  clients.forEach(client => {
    if (client.room === roomName && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(data));
    }
  });
}

// Rate limit
function checkRateLimit(client) {
  const now = Date.now();
  // Remove timestamps antigos
  client.lastMessages = client.lastMessages.filter(t => now - t < TIME_WINDOW_MS);

  if (client.lastMessages.length >= MAX_MESSAGES) {
    return false; // excedeu limite
  }
  client.lastMessages.push(now);
  return true;
}

// ======================
//    COMANDOS
// ======================
function handleCommand(client, command, args) {
  const userIsAdmin = isAdmin(client.username);

  switch (command.toLowerCase()) {

    // Ajuda
    case '+help':
      const helpText = `
        <b>Comandos Disponíveis (v2.0):</b><br>
        <ul>
          <li><b>+help</b>: Lista de comandos</li>
          <li><b>+nick novoNome</b>: Altera seu nome</li>
          <li><b>+private_msg @nick texto</b>: Mensagem privada</li>
          <li><b>+clear_msg</b>: Limpa o chat da sala</li>
          <li><b>+roll d20 / +roll 2d6</b>: Rola dados</li>
          <li><b>+ephemeral texto</b>: Mensagem que some após 10s</li>
          <li><b>+afk</b>: Ativa/Desativa modo AFK</li>
          <li><b>+report @nick motivo</b>: Reporta um usuário para admins</li>
          <li><b>+rooms</b>: Lista salas existentes</li>
          <li><b>+join sala</b>: Entra (ou cria) uma sala</li>
          <li><b>+leave</b>: Volta para a sala padrão (geral)</li>
          ${
            userIsAdmin
            ? `
            <li><b>+ban nick</b> / <b>+unban nick</b></li>
            <li><b>+mute nick</b> / <b>+unmute nick</b></li>
            `
            : ''
          }
        </ul>
      `;
      sendToClient(client, { type: 'system', message: helpText });
      break;

    // Muda nome
    case '+nick':
      if (!args[0]) {
        return sendToClient(client, { type: 'system', message: 'Uso: +nick <novoNome>' });
      }
      const oldName = client.username;
      const newName = filterBadWords(args[0]).trim();
      // Se já banido, impede
      if (isUserBanned(newName)) {
        return sendToClient(client, { type: 'system', message: 'Este nick está banido.' });
      }
      // Se oldName era admin, e trocou, remove da lista (exemplo simplificado).
      if (isAdmin(oldName)) {
        admins = admins.filter(a => a.toLowerCase() !== oldName.toLowerCase());
      }
      client.username = newName;
      broadcast(client.room, {
        type: 'system',
        message: `<b>${oldName}</b> agora é <b>${newName}</b>.`
      });
      break;

    // Mensagem privada
    case '+private_msg':
      if (!args[0] || !args[1]) {
        return sendToClient(client, { type: 'system', message: 'Uso: +private_msg @nick <texto>' });
      }
      if (!args[0].startsWith('@')) {
        return sendToClient(client, { type: 'system', message: 'Inclua @nick no comando.' });
      }
      const targetNick = args[0].substring(1);
      const targetClient = findClientByName(targetNick);
      if (!targetClient) {
        return sendToClient(client, { type: 'system', message: 'Usuário não encontrado.' });
      }
      if (targetClient.isBanned) {
        return sendToClient(client, { type: 'system', message: 'Usuário está banido.' });
      }
      if (targetClient.isMuted) {
        // Aqui você pode avisar que ele está mutado, mas a msg privada ainda seria entregue
        // Decisão de design. Vou permitir, pois é privado.
      }
      const privateMsg = args.slice(1).join(' ');
      const formattedPM = formatMessage(privateMsg, client);
      sendToClient(client, {
        type: 'private',
        from: client.username,
        to: targetClient.username,
        message: `(Para @${targetClient.username}) ${formattedPM}`
      });
      sendToClient(targetClient, {
        type: 'private',
        from: client.username,
        to: targetClient.username,
        message: `(De @${client.username}) ${formattedPM}`
      });
      break;

    // Limpa sala
    case '+clear_msg':
      broadcast(client.room, { type: 'clear' });
      broadcast(client.room, {
        type: 'system',
        message: `<b>${client.username}</b> limpou o chat.`
      });
      break;

    // Ban / Unban
    case '+ban':
      if (!userIsAdmin) {
        return sendToClient(client, { type: 'system', message: 'Acesso negado.' });
      }
      if (!args[0]) {
        return sendToClient(client, { type: 'system', message: 'Uso: +ban <nick>' });
      }
      {
        const banNick = args[0].toLowerCase();
        if (bannedUsers.includes(banNick)) {
          return sendToClient(client, { type: 'system', message: 'Usuário já banido.' });
        }
        bannedUsers.push(banNick);
        broadcast(client.room, {
          type: 'system',
          message: `<b>${args[0]}</b> foi banido.`
        });
        // Desconecta se estiver online
        const banClient = findClientByName(banNick);
        if (banClient) {
          banClient.isBanned = true;
          disconnectUser(banClient);
        }
      }
      break;

    case '+unban':
      if (!userIsAdmin) {
        return sendToClient(client, { type: 'system', message: 'Acesso negado.' });
      }
      if (!args[0]) {
        return sendToClient(client, { type: 'system', message: 'Uso: +unban <nick>' });
      }
      {
        const unbanNick = args[0].toLowerCase();
        bannedUsers = bannedUsers.filter(u => u !== unbanNick);
        broadcast(client.room, {
          type: 'system',
          message: `<b>${args[0]}</b> foi desbanido.`
        });
      }
      break;

    // Mute / Unmute
    case '+mute':
      if (!userIsAdmin) {
        return sendToClient(client, { type: 'system', message: 'Acesso negado.' });
      }
      if (!args[0]) {
        return sendToClient(client, { type: 'system', message: 'Uso: +mute <nick>' });
      }
      {
        const muteC = findClientByName(args[0]);
        if (!muteC) {
          return sendToClient(client, { type: 'system', message: 'Usuário não encontrado.' });
        }
        muteC.isMuted = true;
        broadcast(client.room, {
          type: 'system',
          message: `<b>${muteC.username}</b> foi mutado.`
        });
      }
      break;

    case '+unmute':
      if (!userIsAdmin) {
        return sendToClient(client, { type: 'system', message: 'Acesso negado.' });
      }
      if (!args[0]) {
        return sendToClient(client, { type: 'system', message: 'Uso: +unmute <nick>' });
      }
      {
        const unmuteC = findClientByName(args[0]);
        if (!unmuteC) {
          return sendToClient(client, { type: 'system', message: 'Usuário não encontrado.' });
        }
        unmuteC.isMuted = false;
        broadcast(client.room, {
          type: 'system',
          message: `<b>${unmuteC.username}</b> foi desmutado.`
        });
      }
      break;

    // Rola dados
    case '+roll':
      // Ex: +roll d20 / +roll 2d6 / +roll 1d100
      // Se nao tiver args, rola 1d6 por default
      const diceArg = args[0] || '1d6';
      const matchRoll = diceArg.match(/^(\d*)d(\d+)$/i);
      if (!matchRoll) {
        // formato inválido
        return sendToClient(client, { type: 'system', message: 'Uso: +roll [NdM], ex: +roll d20 ou +roll 2d6' });
      }
      let [_, quant, faces] = matchRoll; // ex: '2', '6'
      quant = quant ? parseInt(quant) : 1;
      const max = parseInt(faces);
      if (isNaN(quant) || isNaN(max) || quant < 1 || max < 2) {
        return sendToClient(client, { type: 'system', message: 'Formato inválido.' });
      }
      let rolls = [];
      for (let i=0; i<quant; i++) {
        rolls.push(Math.floor(Math.random() * max) + 1);
      }
      const total = rolls.reduce((a,b) => a+b, 0);
      broadcast(client.room, {
        type: 'system',
        message: `<b>${client.username}</b> rolou ${diceArg} => [${rolls.join(', ')}], total = ${total}.`
      });
      break;

    // Mensagem efêmera
    case '+ephemeral':
      // +ephemeral texto...
      if (args.length === 0) {
        return sendToClient(client, { type: 'system', message: 'Uso: +ephemeral <texto>' });
      }
      const ephemeralMsg = args.join(' ');
      const formattedEph = formatMessage(ephemeralMsg, client);
      const ephemeralID = 'eph-' + Date.now();
      // Envia a todos da sala, mas com flag ephemeral
      broadcast(client.room, {
        type: 'ephemeral',
        id: ephemeralID,
        username: client.username,
        message: formattedEph
      });
      // Remove após 10s
      setTimeout(() => {
        broadcast(client.room, {
          type: 'remove_ephemeral',
          id: ephemeralID
        });
      }, 10000);
      break;

    // AFK
    case '+afk':
      client.isAFK = !client.isAFK;
      broadcast(client.room, {
        type: 'system',
        message: `<b>${client.username}</b> está ${client.isAFK ? 'AFK' : 'ativo'} agora.`
      });
      break;

    // Report
    case '+report':
      if (!args[0] || !args[1] || !args[0].startsWith('@')) {
        return sendToClient(client, { type: 'system', message: 'Uso: +report @nick motivo' });
      }
      const reportedNick = args[0].substring(1);
      const reason = args.slice(1).join(' ');
      reports.push({
        reporter: client.username,
        reported: reportedNick,
        reason: reason,
        timestamp: new Date().toISOString()
      });
      sendToClient(client, { type: 'system', message: 'Relatório enviado aos admins.' });
      break;

    // Listar salas
    case '+rooms':
      // Pega lista de salas
      const roomList = [...new Set(clients.map(c => c.room))];
      sendToClient(client, {
        type: 'system',
        message: `Salas ativas: <b>${roomList.join('</b>, <b>')}</b>`
      });
      break;

    // Entrar em sala
    case '+join':
      if (!args[0]) {
        return sendToClient(client, { type: 'system', message: 'Uso: +join <nomeDaSala>' });
      }
      const newRoom = args[0];
      // Sai da sala anterior
      broadcast(client.room, {
        type: 'system',
        message: `<b>${client.username}</b> saiu da sala.`
      });
      client.room = newRoom;
      broadcast(client.room, {
        type: 'system',
        message: `<b>${client.username}</b> entrou na sala "${newRoom}".`
      });
      break;

    // Sair de sala (voltar para "geral")
    case '+leave':
      // Sala padrão
      broadcast(client.room, {
        type: 'system',
        message: `<b>${client.username}</b> saiu da sala.`
      });
      client.room = 'geral';
      broadcast(client.room, {
        type: 'system',
        message: `<b>${client.username}</b> entrou na sala "geral".`
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

// ======================
//   WEBSOCKET EVENTS
// ======================
wss.on('connection', (ws) => {
  const client = {
    ws,
    userID: generateUserID(),
    username: 'Anônimo',
    room: 'geral',
    isMuted: false,
    isBanned: false,
    isAFK: false,
    avatar: null,
    lastMessages: []
  };
  clients.push(client);

  ws.on('message', (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch (err) {
      console.error('Erro ao fazer parse da mensagem:', err);
      return;
    }

    if (data.type === 'connect') {
      // Quando usuário conecta, definimos username e avatar
      let sanitizedUsername = filterBadWords(data.username || 'Anônimo');
      if (isUserBanned(sanitizedUsername)) {
        ws.send(JSON.stringify({ type: 'system', message: 'Você está banido do chat.' }));
        ws.close();
        return;
      }
      client.username = sanitizedUsername;
      client.avatar = data.avatar || null;
      broadcast(client.room, {
        type: 'system',
        message: `<b>${client.username}</b> entrou na sala "${client.room}".`
      });
      return;
    }

    if (data.type === 'message') {
      // Rate limit
      if (!checkRateLimit(client)) {
        sendToClient(client, {
          type: 'system',
          message: 'Você está enviando mensagens muito rapidamente.'
        });
        return;
      }
      // Está mutado?
      if (client.isMuted) {
        sendToClient(client, {
          type: 'system',
          message: 'Você está mutado e não pode enviar mensagens.'
        });
        return;
      }
      const rawText = data.message || '';
      const trimmedText = rawText.trim();
      // Comando?
      if (trimmedText.startsWith('+')) {
        const parts = trimmedText.split(' ');
        const command = parts[0];
        const args = parts.slice(1);
        handleCommand(client, command, args);
      } else {
        // Mensagem comum
        const formattedMsg = formatMessage(trimmedText, client);
        const timestamp = new Date().toISOString();
        // Salva no log
        logMessage({
          type: 'message',
          room: client.room,
          username: client.username,
          message: formattedMsg,
          timestamp
        });
        // Envia para todos na sala
        broadcast(client.room, {
          type: 'message',
          username: client.username,
          message: formattedMsg
        });
      }
    }
  });

  ws.on('close', () => {
    clients = clients.filter(c => c !== client);
    broadcast(client.room, {
      type: 'system',
      message: `<b>${client.username}</b> saiu do chat.`
    });
  });
});

// =========================
//    ROTA: PAINEL ADM
// =========================
app.get('/control_adm.html', (req, res) => {
  const pass = req.query.admin_pass;
  if (pass !== ADMIN_PASS) {
    return res.status(403).send('<h1>Acesso Negado</h1>');
  }
  res.sendFile(__dirname + '/control_adm.html');
});

// Rota: Adicionar admin
app.post('/adm/add', (req, res) => {
  const { nick, admin_pass } = req.body;
  if (admin_pass !== ADMIN_PASS) {
    return res.status(403).json({ error: 'Acesso negado.' });
  }
  if (!nick) {
    return res.status(400).json({ error: 'Nick inválido.' });
  }
  if (isAdmin(nick)) {
    return res.status(400).json({ error: 'Já é admin.' });
  }
  admins.push(nick);
  console.log('[Admin Panel] Novo admin:', nick);
  return res.status(200).json({ message: 'Admin adicionado com sucesso.' });
});

// Rota: Buscar logs e reports para o painel
app.get('/adm/data', (req, res) => {
  const pass = req.query.admin_pass;
  if (pass !== ADMIN_PASS) {
    return res.status(403).json({ error: 'Acesso negado.' });
  }
  return res.status(200).json({
    logs: messageLogs,
    reports
  });
});

// Inicia servidor
server.listen(PORT, () => {
  console.log(`Starchat v2.0 rodando na porta ${PORT}`);
});
