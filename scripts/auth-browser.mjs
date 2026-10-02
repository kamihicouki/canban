// Relay only the initial browser URL to the owning Canban login session.
import net from 'node:net';
const socket = net.createConnection(process.env.CANBAN_AUTH_SOCKET || '');
const timer = setTimeout(() => { socket.destroy(); process.exitCode = 1; }, 5000);
socket.on('connect', () => socket.end(`${JSON.stringify({ nonce: process.env.CANBAN_AUTH_NONCE, url: process.argv[2] })}\n`));
let reply = '';
socket.on('data', (data) => { reply += data; });
socket.on('end', () => { clearTimeout(timer); process.exitCode = reply.trim() === 'OK' ? 0 : 1; });
socket.on('error', () => { clearTimeout(timer); process.exitCode = 1; });
