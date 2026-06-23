import { WebSocket } from "ws";
const ws = new WebSocket("ws://localhost:8787");
ws.on("open", () => ws.send(JSON.stringify({ type:"hello", name:"laptop-adiaz", sounds:["ding.wav","coin.wav"] })));
ws.on("message", (d) => { console.log("CLIENT RECEIVED:", d.toString()); process.exit(0); });
setTimeout(() => { console.log("no message"); process.exit(1); }, 4000);
