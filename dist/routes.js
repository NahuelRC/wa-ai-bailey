"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRoutes = createRoutes;
const express_1 = __importDefault(require("express"));
const path_1 = __importDefault(require("path"));
function createRoutes() {
    const app = (0, express_1.default)();
    app.get('/health', (_, res) => res.json({ ok: true, time: new Date() }));
    app.get('/qr', (req, res) => res.sendFile(path_1.default.join(process.cwd(), 'public/qr.png')));
    return app;
}
//# sourceMappingURL=routes.js.map