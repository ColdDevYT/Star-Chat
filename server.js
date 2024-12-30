// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

// Inicialização do Express
const app = express();

// Middleware para parsear JSON
app.use(express.json());

// Servir arquivos estáticos
app.use(express.static(path.join(__dirname)));

// Configurações de Porta
const DEFAULT_PORT = 3000;
const PORT = process.env.PORT || DEFAULT_PORT;

// Lista de administradores
let admins = [];

// Lista de usuários banidos
let bannedUsers = [];

// Filtro de palavras ofensivas
const bannedWords = ['racista', 'pedofilo', 'sexo'];

// Estrutura de Canais (Rooms)
let rooms = {
  geral: {
    name: 'geral',
    topic: 'Bem-vindo ao canal #geral!',
    messages: [],
    participants: []
  }
};

// Lista de clientes conectados
let clients = [];

// Funções de Utilidade

// Filtrar palavras ofensivas
function filterBadWords(text) {
  let sanitized = text;
  bannedWords.forEach(word => {
    const regex = new RegExp(word, 'gi');
    sanitized = sanitized.replace(regex, '***');
  });
  return sanitized;
}

// Formatar mensagens com Markdown limitado
function parseMarkdown(text) {
  let formatted = text.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>'); // **negrito**
  formatted = formatted.replace(/\*(.*?)\*/g, '<i>$1</i>');      // *itálico*
  formatted = formatted.replace(/~~(.*?)~~/g, '<del>$1</del>'); // ~~tachado~~
  return formatted;
}

// Converter URLs em links clicáveis
function parseLinks(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.replace(urlRegex, url => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
}

// Destacar menções @usuario
function parseMentions(text, clientList) {
  const mentionRegex = /@([a-zA-Z0-9_-]+)/g;
  return text.replace(mentionRegex, (match, p1) => {
    const user = clientList.find(c => c.username.toLowerCase() === p1.toLowerCase());
    return user ? `<span class="mention">@${user.username}</span>` : match;
  });
}

// Formatar mensagem completa
function formatMessage(rawText, clientList) {
  let formatted = filterBadWords(rawText);
  formatted = parseMarkdown(formatted);
  formatted = parseLinks(formatted);
  formatted = parseMentions(formatted, clientList);
  return formatted;
}

// Função para obter ou criar um canal
function getOrCreateRoom(roomName) {
  let r = rooms[roomName];
  if (!r) {
    r = {
      name: roomName,
      topic: `Bem-vindo ao canal #${roomName}!`,
      messages: [],
      participants: []
    };
    rooms[roomName] = r;
  }
  return r;
}

// Retorna o cliente pelo username (ignorando case)
function findClientByName(username) {
  return clients.find(c => c.username.toLowerCase() === username.toLowerCase());
}

// Broadcast para todos os clientes em um canal específico
function broadcastToRoom(roomName, data) {
  const room = rooms[roomName];
  if (!room) return;

  room.participants.forEach(client => {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(data));
    }
  });
}

// Enviar mensagem para um cliente específico
function sendToClient(client, data) {
  if (client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(data));
  }
}

// Verificar se um usuário é admin
function isAdmin(username) {
  return admins.some(admin => admin.toLowerCase() === username.toLowerCase());
}

// Adicionar um cliente à lista
function addClient(ws) {
  const client = {
    ws,
    username: 'Anônimo',
    role: 'user',
    isMuted: false,
    isBanned: false,
    currentRoom: null
  };
  clients.push(client);
  return client;
}

// Remover um cliente da lista
function removeClient(client) {
  clients = clients.filter(c => c !== client);
  // Remover do canal atual
  if (client.currentRoom && rooms[client.currentRoom]) {
    rooms[client.currentRoom].participants = rooms[client.currentRoom].participants.filter(p => p !== client);
    broadcastToRoom(client.currentRoom, {
      type: 'system',
      message: `<b>${client.username}</b> saiu do canal.`
    });
  }
}

// Manipular comandos
function handleCommand(client, command, args) {
  switch (command.toLowerCase()) {
    case '+help':
      const helpText = `
        <b>Comandos Disponíveis:</b><br>
        <ul>
          <li><b>+help</b>: Exibe essa lista de comandos</li>
          <li><b>+nick &lt;novoNome&gt;</b>: Altera seu nome</li>
          <li><b>+rooms</b>: Lista os canais existentes</li>
          <li><b>+join &lt;canal&gt;</b>: Entra no canal especificado</li>
          <li><b>+topic &lt;texto&gt;</b>: Define tópico do canal (somente mod/admin)</li>
          <li><b>+create_room &lt;nome&gt;</b>: Cria um novo canal (somente mod/admin)</li>
          <li><b>+list_history</b>: Lista as últimas mensagens do canal atual</li>
          <li><b>+pin &lt;messageId&gt;</b> / <b>+unpin &lt;messageId&gt;</b>: Pinar/Despin</li>
          <li><b>+mute &lt;usuario&gt;</b> / <b>+unmute &lt;usuario&gt;</b> (somente mod/admin)</li>
          <li><b>+ban &lt;usuario&gt;</b> / <b>+unban &lt;usuario&gt;</b> (somente admin)</li>
          <li><b>+private_msg @usuario mensagem</b>: Envia mensagem privada</li>
          <li><b>+clear_msg</b>: Limpa o histórico do chat (para todos no canal atual)</li>
          <li><b>*texto*</b>: itálico, <b>**texto**</b>: negrito, <b>~~texto~~</b>: tachado</li>
          <li>Menções <b>@usuario</b> destacam a pessoa</li>
          <li>Links (http/https) tornam-se clicáveis</li>
        </ul>
      `;
      sendToClient(client, { type: 'system', message: helpText });
      break;

    case '+nick':
      if (!args[0]) {
        sendToClient(client, { type: 'system', message: 'Uso: +nick <novoNome>' });
        return;
      }
      const newName = filterBadWords(args[0]).trim();
      if (!newName || newName === '***') {
        sendToClient(client, { type: 'system', message: 'Nome inválido.' });
        return;
      }
      const oldName = client.username;
      client.username = newName;
      sendToClient(client, { type: 'system', message: `Seu nome agora é <b>${newName}</b>.` });
      broadcastToRoom(client.currentRoom, {
        type: 'system',
        message: `<b>${oldName}</b> agora é <b>${newName}</b>.`
      });
      break;

    case '+rooms':
      const roomNames = Object.keys(rooms).map(room => `#${room}`).join(', ');
      sendToClient(client, {
        type: 'system',
        message: `<b>Canais existentes:</b> ${roomNames}`
      });
      break;

    case '+join':
      if (!args[0]) {
        sendToClient(client, { type: 'system', message: 'Uso: +join <nomeDoCanal>' });
        return;
      }
      const roomName = args[0];
      const room = rooms[roomName] || getOrCreateRoom(roomName);

      // Remover do canal anterior
      if (client.currentRoom && rooms[client.currentRoom]) {
        rooms[client.currentRoom].participants = rooms[client.currentRoom].participants.filter(p => p !== client);
        broadcastToRoom(client.currentRoom, {
          type: 'system',
          message: `<b>${client.username}</b> saiu do canal.`
        });
      }

      // Adicionar ao novo canal
      client.currentRoom = roomName;
      room.participants.push(client);
      sendToClient(client, {
        type: 'system',
        message: `Você entrou no canal <b>#${roomName}</b>. Tópico: "${room.topic}"`
      });
      broadcastToRoom(roomName, {
        type: 'system',
        message: `<b>${client.username}</b> entrou no canal.`
      });
      break;

    case '+topic':
      if (!client.currentRoom) {
        sendToClient(client, { type: 'system', message: 'Você não está em nenhum canal.' });
        return;
      }
      if (client.role !== 'mod' && client.role !== 'admin') {
        sendToClient(client, { type: 'system', message: 'Apenas moderadores ou administradores podem alterar o tópico.' });
        return;
      }
      const topic = args.join(' ');
      if (!topic) {
        sendToClient(client, { type: 'system', message: 'Uso: +topic <novo tópico>' });
        return;
      }
      rooms[client.currentRoom].topic = topic;
      broadcastToRoom(client.currentRoom, {
        type: 'system',
        message: `<b>${client.username}</b> alterou o tópico para: "${topic}"`
      });
      break;

    case '+create_room':
      if (client.role !== 'mod' && client.role !== 'admin') {
        sendToClient(client, { type: 'system', message: 'Apenas moderadores ou administradores podem criar canais.' });
        return;
      }
      if (!args[0]) {
        sendToClient(client, { type: 'system', message: 'Uso: +create_room <nome>' });
        return;
      }
      const newRoomName = args[0];
      if (rooms[newRoomName]) {
        sendToClient(client, { type: 'system', message: 'Esse canal já existe.' });
        return;
      }
      rooms[newRoomName] = {
        name: newRoomName,
        topic: `Bem-vindo ao canal #${newRoomName}!`,
        messages: [],
        participants: []
      };
      sendToClient(client, { type: 'system', message: `Canal <b>#${newRoomName}</b> criado com sucesso.` });
      break;

    case '+list_history':
      if (!client.currentRoom) {
        sendToClient(client, { type: 'system', message: 'Você não está em nenhum canal.' });
        return;
      }
      const history = rooms[client.currentRoom].messages.slice(-10).map(msg => {
        return `<b>[${msg.id}] ${msg.sender}:</b> ${msg.text} ${msg.pinned ? '📌' : ''}`;
      }).join('<br>');
      sendToClient(client, { type: 'system', message: `<b>Últimas mensagens em #${client.currentRoom}:</b><br>${history}` });
      break;

    case '+pin':
      if (!client.currentRoom) {
        sendToClient(client, { type: 'system', message: 'Você não está em nenhum canal.' });
        return;
      }
      if (client.role !== 'mod' && client.role !== 'admin') {
        sendToClient(client, { type: 'system', message: 'Apenas moderadores ou administradores podem fixar mensagens.' });
        return;
      }
      const pinId = parseInt(args[0], 10);
      if (isNaN(pinId)) {
        sendToClient(client, { type: 'system', message: 'Uso: +pin <messageId>' });
        return;
      }
      const pinMessage = rooms[client.currentRoom].messages.find(m => m.id === pinId);
      if (!pinMessage) {
        sendToClient(client, { type: 'system', message: 'Mensagem não encontrada.' });
        return;
      }
      pinMessage.pinned = true;
      broadcastToRoom(client.currentRoom, {
        type: 'system',
        message: `<b>${client.username}</b> fixou a mensagem [${pinId}].`
      });
      break;

    case '+unpin':
      if (!client.currentRoom) {
        sendToClient(client, { type: 'system', message: 'Você não está em nenhum canal.' });
        return;
      }
      if (client.role !== 'mod' && client.role !== 'admin') {
        sendToClient(client, { type: 'system', message: 'Apenas moderadores ou administradores podem desfixar mensagens.' });
        return;
      }
      const unpinId = parseInt(args[0], 10);
      if (isNaN(unpinId)) {
        sendToClient(client, { type: 'system', message: 'Uso: +unpin <messageId>' });
        return;
      }
      const unpinMessage = rooms[client.currentRoom].messages.find(m => m.id === unpinId);
      if (!unpinMessage) {
        sendToClient(client, { type: 'system', message: 'Mensagem não encontrada.' });
        return;
      }
      unpinMessage.pinned = false;
      broadcastToRoom(client.currentRoom, {
        type: 'system',
        message: `<b>${client.username}</b> desfixou a mensagem [${unpinId}].`
      });
      break;

    case '+mute':
      if (client.role !== 'mod' && client.role !== 'admin') {
        sendToClient(client, { type: 'system', message: 'Apenas moderadores ou administradores podem mutar usuários.' });
        return;
      }
      const muteUserName = args[0];
      if (!muteUserName) {
        sendToClient(client, { type: 'system', message: 'Uso: +mute <usuario>' });
        return;
      }
      const muteClient = findClientByName(muteUserName);
      if (!muteClient) {
        sendToClient(client, { type: 'system', message: 'Usuário não encontrado.' });
        return;
      }
      muteClient.isMuted = true;
      sendToClient(muteClient, { type: 'system', message: 'Você foi mutado.' });
      broadcastToRoom(muteClient.currentRoom, {
        type: 'system',
        message: `<b>${muteClient.username}</b> foi mutado por <b>${client.username}</b>.`
      });
      break;

    case '+unmute':
      if (client.role !== 'mod' && client.role !== 'admin') {
        sendToClient(client, { type: 'system', message: 'Apenas moderadores ou administradores podem desmutar usuários.' });
        return;
      }
      const unmuteUserName = args[0];
      if (!unmuteUserName) {
        sendToClient(client, { type: 'system', message: 'Uso: +unmute <usuario>' });
        return;
      }
      const unmuteClient = findClientByName(unmuteUserName);
      if (!unmuteClient) {
        sendToClient(client, { type: 'system', message: 'Usuário não encontrado.' });
        return;
      }
      unmuteClient.isMuted = false;
      sendToClient(unmuteClient, { type: 'system', message: 'Você foi desmutado.' });
      broadcastToRoom(unmuteClient.currentRoom, {
        type: 'system',
        message: `<b>${unmuteClient.username}</b> foi desmutado por <b>${client.username}</b>.`
      });
      break;

    case '+ban':
      if (client.role !== 'admin') {
        sendToClient(client, { type: 'system', message: 'Apenas administradores podem banir usuários.' });
        return;
      }
      const banUserName = args[0];
      if (!banUserName) {
        sendToClient(client, { type: 'system', message: 'Uso: +ban <usuario>' });
        return;
      }
      if (bannedUsers.includes(banUserName.toLowerCase())) {
        sendToClient(client, { type: 'system', message: 'Usuário já está banido.' });
        return;
      }
      bannedUsers.push(banUserName.toLowerCase());
      const banClient = findClientByName(banUserName);
      if (banClient) {
        sendToClient(banClient, { type: 'system', message: 'Você foi banido do chat.' });
        banClient.ws.close();
      }
      broadcastToRoom(client.currentRoom, {
        type: 'system',
        message: `<b>${banUserName}</b> foi banido por <b>${client.username}</b>.`
      });
      break;

    case '+unban':
      if (client.role !== 'admin') {
        sendToClient(client, { type: 'system', message: 'Apenas administradores podem desbanir usuários.' });
        return;
      }
      const unbanUserName = args[0];
      if (!unbanUserName) {
        sendToClient(client, { type: 'system', message: 'Uso: +unban <usuario>' });
        return;
      }
      bannedUsers = bannedUsers.filter(u => u !== unbanUserName.toLowerCase());
      broadcastToRoom(client.currentRoom, {
        type: 'system',
        message: `<b>${unbanUserName}</b> foi desbanido por <b>${client.username}</b>.`
      });
      break;

    case '+private_msg':
      const targetName = args[0] && args[0].startsWith('@') ? args[0].substring(1) : null;
      const privateMsg = args.slice(1).join(' ');
      if (!targetName || !privateMsg) {
        sendToClient(client, { type: 'system', message: 'Uso: +private_msg @usuario mensagem' });
        return;
      }
      const targetClient = findClientByName(targetName);
      if (!targetClient) {
        sendToClient(client, { type: 'system', message: `Usuário ${args[0]} não encontrado.` });
        return;
      }
      if (targetClient.isBanned) {
        sendToClient(client, { type: 'system', message: `Usuário ${args[0]} está banido.` });
        return;
      }
      const formattedPM = formatMessage(privateMsg, clients);
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

    case '+clear_msg':
      if (!client.currentRoom) {
        sendToClient(client, { type: 'system', message: 'Você não está em nenhum canal.' });
        return;
      }
      rooms[client.currentRoom].messages = [];
      broadcastToRoom(client.currentRoom, { type: 'clear' });
      broadcastToRoom(client.currentRoom, {
        type: 'system',
        message: `<b>${client.username}</b> limpou o chat nesse canal.`
      });
      break;

    default:
      sendToClient(client, { type: 'system', message: 'Comando não reconhecido. Use +help para ver a lista de comandos.' });
      break;
  }
}

// Manipulação de Conexão WebSocket
let globalMsgId = 1; // ID incremental para mensagens

const wss = new WebSocket.Server({ server: http.createServer(app) });

// Agora que criamos o servidor WebSocket, podemos ligar o WebSocket Server ao servidor HTTP
wss.on('connection', (ws) => {
  const client = addClient(ws);

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      console.error('Erro ao parsear mensagem:', err);
      return;
    }

    if (data.type === 'connect') {
      // Definir nome de usuário
      const sanitizedUsername = filterBadWords(data.username || 'Anônimo').trim();

      if (bannedUsers.includes(sanitizedUsername.toLowerCase())) {
        sendToClient(client, { type: 'system', message: 'Você está banido do chat.' });
        ws.close();
        return;
      }

      client.username = sanitizedUsername;
      client.role = isAdmin(client.username) ? 'admin' : 'user';

      // Conectar ao canal geral por padrão
      client.currentRoom = 'geral';
      rooms['geral'].participants.push(client);

      // Mensagem de boas-vindas
      broadcastToRoom('geral', {
        type: 'system',
        message: `<b>${client.username}</b> entrou no canal.`
      });

      // Enviar boas-vindas ao cliente
      sendToClient(client, {
        type: 'system',
        message: `Bem-vindo(a) ao canal <b>#geral</b>! Tópico: "${rooms['geral'].topic}"`
      });
    } else if (data.type === 'message') {
      // Verificar se o usuário está banido
      if (bannedUsers.includes(client.username.toLowerCase())) {
        sendToClient(client, { type: 'system', message: 'Você está banido do chat.' });
        ws.close();
        return;
      }

      // Verificar se o usuário está mutado
      if (client.isMuted) {
        sendToClient(client, { type: 'system', message: 'Você está mutado e não pode enviar mensagens.' });
        return;
      }

      const message = data.message.trim();
      if (!message) return;

      // Verificar se é um comando
      if (message.startsWith('+')) {
        const parts = message.split(' ');
        const command = parts[0];
        const args = parts.slice(1);
        handleCommand(client, command, args);
      } else {
        // Mensagem normal
        if (!client.currentRoom || !rooms[client.currentRoom]) {
          sendToClient(client, { type: 'system', message: 'Você não está em nenhum canal.' });
          return;
        }

        const formattedMsg = formatMessage(message, clients);
        const room = rooms[client.currentRoom];
        const messageId = globalMsgId++;

        const messageObj = {
          id: messageId,
          sender: client.username,
          text: formattedMsg,
          pinned: false,
          timestamp: Date.now()
        };

        room.messages.push(messageObj);

        // Broadcast para o canal
        broadcastToRoom(client.currentRoom, {
          type: 'message',
          username: client.username,
          messageId: messageId,
          message: formattedMsg
        });
      }
    }
  });

  ws.on('close', () => {
    removeClient(client);
  });

  ws.on('error', (error) => {
    console.error('Erro no WebSocket:', error);
    removeClient(client);
  });
});

// Rotas Administrativas

// Rota para acessar o painel admin com proteção por senha
app.get('/control_adm.html', (req, res) => {
  const pass = req.query.admin_pass;
  if (pass !== '1234') { // Substitua '1234' por uma senha segura
    return res.status(403).send('<h1>Acesso Negado</h1>');
  }
  res.sendFile(path.join(__dirname, 'control_adm.html'));
});

// Rota para adicionar administrador
app.post('/adm/add', (req, res) => {
  const { nick, admin_pass } = req.body;
  if (admin_pass !== '1234') { // Substitua '1234' por uma senha segura
    return res.status(403).json({ error: 'Acesso negado.' });
  }
  if (!nick) {
    return res.status(400).json({ error: 'Nick não informado.' });
  }
  if (isAdmin(nick)) {
    return res.status(400).json({ error: 'Usuário já é admin.' });
  }
  admins.push(nick);
  const targetClient = findClientByName(nick);
  if (targetClient) {
    targetClient.role = 'admin';
    sendToClient(targetClient, { type: 'system', message: 'Você foi promovido a Administrador.' });
  }
  return res.status(200).json({ message: `Usuário ${nick} agora é Admin.` });
});

// Rota para definir Moderador
app.post('/adm/setmod', (req, res) => {
  const { nick, admin_pass } = req.body;
  if (admin_pass !== '1234') { // Substitua '1234' por uma senha segura
    return res.status(403).json({ error: 'Acesso negado.' });
  }
  if (!nick) {
    return res.status(400).json({ error: 'Nick não informado.' });
  }
  const targetClient = findClientByName(nick);
  if (!targetClient) {
    return res.status(404).json({ error: 'Usuário não encontrado (não está online).' });
  }
  targetClient.role = 'mod';
  sendToClient(targetClient, { type: 'system', message: 'Você foi promovido a Moderador.' });
  return res.status(200).json({ message: `Usuário ${nick} agora é Moderador.` });
});

// Tratamento de Erros do Servidor
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Porta ${PORT} já está em uso. Tente outra porta.`);
    process.exit(1);
  } else {
    console.error('Erro no servidor:', error);
  }
});

// Iniciar o Servidor
const serverInstance = http.createServer(app);
serverInstance.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
