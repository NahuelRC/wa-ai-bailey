"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("./config");
const routes_1 = require("./routes");
const wa_1 = require("./wa");
async function main() {
    const app = (0, routes_1.createRoutes)();
    app.listen(config_1.cfg.PORT, () => console.log(`🌐 HTTP en :${config_1.cfg.PORT} | /health | /qr`));
    const wa = (0, wa_1.createWA)();
    await wa.initialize();
}
main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map