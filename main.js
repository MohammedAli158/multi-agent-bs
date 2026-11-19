import express from 'express';
import { createServer } from 'http';              
import { init } from './socket/socket.js';        
export const app = express();

const httpServer = createServer(app);
const io = init(httpServer);

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('message', (data) => {
    console.log('Message received:', data);
    socket.broadcast.emit('message', data);
  });

  socket.on('disconnect', (reason) => {
    console.log(`User disconnected: ${socket.id} (${reason})`);
  });
});

// Define routes and middleware here
app.get('/health', (req, res) => {
  return res.json({ success: true });            
});

app.get('/', (req, res) => {                     
  return res.send('OK');
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {                   
  console.log(`Server listening on *:${PORT}`);
});