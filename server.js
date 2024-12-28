// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const sanitizeHtml = require('sanitize-html');

// Configurações de segurança
const app = express();
app.use(helmet());

// Limitar requisições para endpoints sensíveis
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100, // Limite de 100 requisições por IP
  message: 'Muitas tentativas de acesso. Tente novamente mais tarde.'
});

app.use('/control_adm.html', loginLimiter);

// Serve todos os arquivos estáticos da pasta atual
app.use(express.static(__dirname));

// Cria o servidor HTTP
const server = http.createServer(app);

// Cria o WebSocket Server a partir do servidor HTTP
const wss = new WebSocket.Server({ server });

// Listas de conexões e administração
let clients = [];
let admins = []; // Lista de usernames administradores (em lowercase)
let bannedUsers = []; // Lista de usernames banidos (em lowercase)
let mutedUsers = []; // Lista de usernames mutados (em lowercase)

// Armazenamento de admins com senhas hashadas
let adminCredentials = {}; // { username: hashedPassword }

// Palavra(s) chave para autenticação de admin (Defina uma senha segura)
const ADMIN_PASSWORD = '92-033-192';
const bannedWords = ['racista', 'pedofilo', 'sexo', 'porra', 'puta', 'caralho', 'prr', 'fdp', 'foda', 'fds', 'vsfd', 'vagabundo', 'vagabun', 'vadia', 'vadi', 'pau', 'cu', 'bct', 'buceta']; // Palavras banidas

// === Funções de Utilidade ===

// Inicializar credenciais do admin
(async () => {
  const hashedPassword = await bcrypt.hash(ADMIN_PASSWORD, 10);
  adminCredentials['admin'] = hashedPassword; // Username padrão: 'admin'
})();

// Substitui palavras banidas por '***'
function filterBadWords(text) {
  let sanitizedText = text;
  bannedWords.forEach((word) => {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
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

// Sanitiza e formata a mensagem
function formatMessage(rawText, clientList) {
  let sanitized = sanitizeHtml(rawText, {
    allowedTags: [], // Remove todas as tags HTML
    allowedAttributes: {}
  });
  sanitized = filterBadWords(sanitized);
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

// Envia a lista de usuários conectados para um administrador
function sendUserList(client) {
  const usernames = clients.map(c => c.username);
  sendToClient(client, {
    type: 'user_list',
    users: usernames
  });
}

// === Comandos ===

async function handleCommand(client, command, args) {
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

    case '+nick':
      if (!args[0]) {
        sendToClient(client, {
          type: 'system',
          message: 'Uso: +nick <novoNome>'
        });
        return;
      }
      const desiredNick = sanitizeHtml(args[0].trim());
      const desiredNickLower = desiredNick.toLowerCase();
      if (desiredNick === '') {
        sendToClient(client, {
          type: 'system',
          message: 'Nome de usuário inválido.'
        });
        return;
      }
      // Verifica se o nome já está em uso
      const existingUser = clients.find(c => c.username.toLowerCase() === desiredNickLower);
      if (existingUser && existingUser !== client) {
        sendToClient(client, {
          type: 'system',
          message: `O nome de usuário "${desiredNick}" já está em uso. Por favor, escolha outro.`
        });
        return;
      }
      const oldName = client.username;
      client.username = desiredNick;
      broadcast({
        type: 'system',
        message: `<b>${oldName}</b> mudou seu nome para <b>${client.username}</b>.`
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

    case '+private_msg':
      // Esperamos algo como: +private_msg @fulano Mensagem
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
      const targetUsernamePM = args[0].substring(1).toLowerCase();
      const targetClientPM = clients.find(
        (c) => c.username.toLowerCase() === targetUsernamePM
      );
      if (!targetClientPM) {
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
        to: targetClientPM.username,
        message: `(Para @${targetClientPM.username}) ${formattedPM}`
      });
      // Envia para o destinatário
      sendToClient(targetClientPM, {
        type: 'private',
        from: client.username,
        to: targetClientPM.username,
        message: `(De @${client.username}) ${formattedPM}`
      });
      break;

    case '+clear_msg':
      if (!isAdmin(client.username)) {
        sendToClient(client, {
          type: 'system',
          message: 'Você não tem permissão para executar este comando.'
        });
        return;
      }
      broadcast({
        type: 'clear'
      });
      broadcast({
        type: 'system',
        message: `<b>${client.username}</b> limpou o chat.`
      });
      break;

    case '+list_users':
      if (!isAdmin(client.username)) {
        sendToClient(client, {
          type: 'system',
          message: 'Você não tem permissão para executar este comando.'
        });
        return;
      }
      sendUserList(client);
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

  ws.on('message', async (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (error) {
      console.error('Erro ao fazer parse da mensagem:', error);
      return;
    }

    // data: { type: 'connect' | 'admin_auth' | 'message' | 'add_admin', ... }
    if (data.type === 'connect') {
      // Quando o usuário entra com seu username
      const desiredUsername = sanitizeHtml(data.username.trim());
      const desiredUsernameLower = desiredUsername.toLowerCase();

      // Verifica se o usuário está banido
      if (bannedUsers.includes(desiredUsernameLower)) {
        sendToClient(client, {
          type: 'system',
          message: 'Você está banido do chat.'
        });
        ws.close();
        return;
      }

      // Verifica se o nome já está em uso
      const existingUser = clients.find(c => c.username.toLowerCase() === desiredUsernameLower);
      if (existingUser && existingUser !== client) {
        sendToClient(client, {
          type: 'system',
          message: `O nome de usuário "${desiredUsername}" já está em uso. Por favor, escolha outro.`
        });
        ws.close();
        return;
      }

      client.username = desiredUsername;
      broadcast({
        type: 'system',
        message: `<b>${client.username}</b> entrou no chat.`
      });
    } else if (data.type === 'admin_auth') {
      // Autenticação de administrador
      const username = client.username.toLowerCase();
      const password = data.password;
      if (!adminCredentials[username]) {
        sendToClient(client, {
          type: 'system',
          message: 'Usuário não é um administrador.'
        });
        return;
      }
      const match = await bcrypt.compare(password, adminCredentials[username]);
      if (match) {
        if (!admins.includes(username)) {
          admins.push(username);
        }
        sendToClient(client, {
          type: 'system',
          message: 'Autenticado como administrador.'
        });
        broadcast({
          type: 'system',
          message: `<b>${client.username}</b> foi autenticado como administrador.`
        });
        sendUserList(client);
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
      const newAdmin = sanitizeHtml(data.new_admin.trim()).toLowerCase();
      if (!newAdmin) {
        sendToClient(client, {
          type: 'system',
          message: 'Nome de usuário inválido para adicionar como administrador.'
        });
        return;
      }
      if (admins.includes(newAdmin)) {
        sendToClient(client, {
          type: 'system',
          message: `Usuário @${newAdmin} já é um administrador.`
        });
        return;
      }
      if (!adminCredentials[newAdmin]) {
        // Se o usuário ainda não é admin, precisa definir uma senha
        // Neste exemplo, não estamos permitindo definir uma senha via chat
        sendToClient(client, {
          type: 'system',
          message: `Usuário @${newAdmin} não possui credenciais de administrador. Defina uma senha no backend.`
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
    const usernameLower = client.username.toLowerCase();
    const indexAdmin = admins.indexOf(usernameLower);
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
