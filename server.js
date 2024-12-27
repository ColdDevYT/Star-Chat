// Importa os módulos necessários
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

// Configurações básicas
const PORT = process.env.PORT || 8080; // Porta para deploy em serviços como Render
const app = express();

// Serve os arquivos estáticos (HTML, CSS, JS, etc.) da pasta atual
app.use(express.static(path.join(__dirname, '/')));

// Cria o servidor HTTP
const server = http.createServer(app);

// Anexa o WebSocket ao servidor HTTP
const wss = new WebSocket.Server({ server });

// Lista de usuários conectados
let users = [];

// Evento de conexão WebSocket
wss.on('connection', (ws) => {
    console.log('Novo cliente conectado!');

    // Adiciona o cliente à lista de usuários
    const user = { ws, username: null };
    users.push(user);

    // Evento de mensagem recebida
    ws.on('message', (rawData) => {
        let data;
        try {
            data = JSON.parse(rawData);
        } catch (error) {
            console.error('Erro ao analisar mensagem JSON:', error);
            return;
        }

        if (data.type === 'setUsername') {
            // Define o nome de usuário
            user.username = data.username;
            console.log(`Usuário definido: ${user.username}`);
        } else if (data.type === 'chatMessage') {
            // Processa mensagens do chat ou comandos
            handleChatMessage(user, data.message);
        }
    });

    // Evento de desconexão
    ws.on('close', () => {
        console.log('Cliente desconectado.');
        users = users.filter(u => u.ws !== ws);
    });
});

// Função para lidar com mensagens de chat e comandos
function handleChatMessage(user, messageText) {
    const trimmedMessage = messageText.trim();

    if (trimmedMessage.startsWith('+')) {
        handleCommand(user, trimmedMessage);
    } else {
        broadcastMessage({
            type: 'chatMessage',
            username: user.username || 'Anônimo',
            message: trimmedMessage
        });
    }
}

// Função para lidar com comandos
function handleCommand(user, commandText) {
    const [command, ...args] = commandText.split(' ');

    switch (command) {
        case '+help':
            sendToUser(user.ws, {
                type: 'serverMessage',
                message: `Comandos disponíveis:\n+help -> Exibe esta lista de comandos\n+private_msg @usuario Mensagem -> Envia mensagem privada\n+clear_msg -> Limpa o chat para todos`
            });
            break;

        case '+private_msg':
            const targetUsername = args[0]?.substring(1); // Remove o @
            const privateMessage = args.slice(1).join(' ');
            const targetUser = users.find(u => u.username === targetUsername);

            if (targetUser) {
                sendToUser(targetUser.ws, {
                    type: 'privateMessage',
                    from: user.username || 'Anônimo',
                    message: privateMessage
                });
                sendToUser(user.ws, {
                    type: 'serverMessage',
                    message: `Mensagem privada enviada para @${targetUsername}`
                });
            } else {
                sendToUser(user.ws, {
                    type: 'serverMessage',
                    message: `Usuário @${targetUsername} não encontrado.`
                });
            }
            break;

        case '+clear_msg':
            broadcastMessage({ type: 'clearChat' });
            break;

        default:
            sendToUser(user.ws, {
                type: 'serverMessage',
                message: `Comando desconhecido: ${command}`
            });
    }
}

// Função para enviar mensagem para um cliente específico
function sendToUser(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    }
}

// Função para broadcast de mensagens para todos os clientes
function broadcastMessage(message) {
    users.forEach(({ ws }) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        }
    });
}

// Inicia o servidor HTTP
server.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
