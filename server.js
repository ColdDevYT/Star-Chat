/****************************************************
 * server.js
 ****************************************************/
const WebSocket = require('ws');
const port = process.env.PORT || 8080; // Para funcionar no Render, use PORT
const wss = new WebSocket.Server({ port });

/** 
 * Armazena os usuários no formato:
 * { ws: WebSocket, username: string }
 */
let users = [];

wss.on('connection', (ws) => {
  console.log('Novo cliente conectado!');
  
  // Adiciona o usuário à lista sem username a princípio
  users.push({ ws, username: null });

  // Quando recebe uma mensagem de um cliente
  ws.on('message', (rawData) => {
    let data;
    try {
      data = JSON.parse(rawData);
    } catch (err) {
      console.log("Erro ao analisar JSON:", err);
      return;
    }

    /**
     * data deve ter um formato:
     * { type: 'setUsername' | 'chatMessage', username, message }
     */
    if (data.type === 'setUsername') {
      // Atualiza a entry do usuário com o username enviado pelo cliente
      const user = users.find(u => u.ws === ws);
      if (user) {
        user.username = data.username;
        console.log(`Usuário configurou nome para: ${user.username}`);
      }
      return;
    }

    if (data.type === 'chatMessage') {
      const user = users.find(u => u.ws === ws);
      if (!user || !user.username) {
        return; // ignora se o usuário não tiver username setado
      }

      const messageText = data.message.trim();

      // Verifica se a mensagem é um comando
      if (messageText.startsWith('+')) {
        handleCommand(messageText, user);
      } else {
        // Mensagem normal: faz broadcast
        broadcastMessage({
          type: 'chatMessage',
          username: user.username,
          message: messageText
        });
      }
    }
  });

  ws.on('close', () => {
    console.log('Cliente desconectado.');
    users = users.filter(u => u.ws !== ws);
  });
});

console.log(`Servidor WebSocket rodando na porta ${port}`);

/* ---------------------------------------------------
 * Funções Auxiliares
 * --------------------------------------------------- */
function handleCommand(commandText, user) {
  const [command, ...args] = commandText.split(' ');

  switch (command) {
    case '+help':
      // Envia ao usuário atual o "manual" de comandos
      sendToUser(user.ws, {
        type: 'serverMessage',
        message: `Comandos disponíveis:
+help -> Exibe esta lista de comandos
+private_msg @nomeUsuario Mensagem -> Envia mensagem privada
+clear_msg -> Limpa o chat de todos`
      });
      break;

    case '+private_msg':
      // Formato esperado: +private_msg @nomeUsuario Mensagem...
      // args[0] deve ser @nomeUsuario
      if (!args[0] || !args[0].startsWith('@')) {
        sendToUser(user.ws, {
          type: 'serverMessage',
          message: `Uso correto: +private_msg @nomeDoUsuario Mensagem...`
        });
        return;
      }
      const targetUsername = args[0].substring(1); // remove '@'
      const privateMsg = args.slice(1).join(' ');
      const targetUser = users.find(u => u.username === targetUsername);

      if (!targetUser) {
        sendToUser(user.ws, {
          type: 'serverMessage',
          message: `Usuário "${targetUsername}" não encontrado.`
        });
        return;
      }

      // Envia mensagem privada somente para o usuário de destino
      sendToUser(targetUser.ws, {
        type: 'privateMessage',
        from: user.username,
        message: privateMsg
      });
      
      // Opcional: avisar ao remetente que a mensagem foi enviada
      sendToUser(user.ws, {
        type: 'serverMessage',
        message: `Mensagem privada enviada para @${targetUsername}: ${privateMsg}`
      });
      break;

    case '+clear_msg':
      // Emite um comando para todos os clientes limparem o chat
      broadcastMessage({ type: 'clearChat' });
      break;

    default:
      // Comando desconhecido
      sendToUser(user.ws, {
        type: 'serverMessage',
        message: `Comando desconhecido: ${command}`
      });
      break;
  }
}

/**
 * Broadcast para todos os usuários conectados
 */
function broadcastMessage(msgObject) {
  users.forEach(({ ws }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msgObject));
    }
  });
}

/**
 * Envia uma mensagem para apenas um usuário
 */
function sendToUser(ws, msgObject) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msgObject));
  }
}
