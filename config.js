// Configure your deployed backend URL here when hosting on GitHub Pages,
// e.g. "https://chat-api.yourdomain.com" or "http://YOUR_SERVER_IP:8080".
// Leave empty "" for automatic local-dev or same-origin Nginx proxy detection.
window.EPIGAEA_BACKEND_URL = "";

window.EpigaeaConfig = (function () {
    const devPorts = ['3000', '3001', '4173', '5173', '5500', '8000', '8080'];

    function resolveConfiguredBackend() {
        const params = new URLSearchParams(window.location.search);
        const paramUrl = params.get('backend');
        if (paramUrl) {
            const clean = paramUrl.replace(/\/+$/, '');
            localStorage.setItem('epigaea_backend_url', clean);
            return clean;
        }
        if (window.EPIGAEA_BACKEND_URL && window.EPIGAEA_BACKEND_URL.trim() !== '') {
            return window.EPIGAEA_BACKEND_URL.trim().replace(/\/+$/, '');
        }
        const stored = localStorage.getItem('epigaea_backend_url');
        return stored ? stored.trim().replace(/\/+$/, '') : '';
    }

    function getApiBase() {
        const configured = resolveConfiguredBackend();
        if (configured) return configured;

        if (window.location.protocol === 'file:' || devPorts.includes(window.location.port)) {
            const host = window.location.hostname || 'localhost';
            return `http://${host}:8082`;
        }
        return '';
    }

    function getWsUrl() {
        const configured = resolveConfiguredBackend();
        if (configured) {
            const wsBase = configured.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
            return `${wsBase}/api/wss`;
        }

        if (window.location.protocol === 'file:' || devPorts.includes(window.location.port)) {
            const host = window.location.hostname || 'localhost';
            return `ws://${host}:8081`;
        }
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${wsProtocol}//${window.location.host}/api/wss`;
    }

    return { getApiBase, getWsUrl };
})();
