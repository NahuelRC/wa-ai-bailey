"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.aiReply = aiReply;
const node_fetch_1 = __importDefault(require("node-fetch"));
const config_1 = require("./config");
async function aiReply(userText, phone) {
    // Guardrail básico: si no hay API key, devolvemos un fallback
    if (!config_1.cfg.OPENAI_API_KEY) {
        return "Soy tu asistente. Configurá OPENAI_API_KEY para respuestas mejoradas.";
    }
    const system = `Sos un agente breve, claro y cordial. Si mencionan 'imagen1', 'imagen2' o 'imagen3', no expliques: solo confirma que enviarás la imagen correspondiente.`;
    const body = {
        model: "gpt-5.1-mini",
        temperature: 0.4,
        messages: [
            { role: "system", content: system },
            { role: "user", content: userText }
        ]
    };
    const res = await (0, node_fetch_1.default)("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${config_1.cfg.OPENAI_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content?.trim() || "¿En qué puedo ayudarte?";
    return text;
}
//# sourceMappingURL=ai.js.map