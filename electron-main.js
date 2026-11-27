const { app, BrowserWindow, session, desktopCapturer } = require('electron');
const path = require('path');

function createWindow() {
    const win = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 900,
        minHeight: 600,
        icon: path.join(__dirname, 'assets', 'favicon.png'),
        autoHideMenuBar: true,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
    // Allow microphone, camera, and screen-share permissions in Electron
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
        if (['media', 'display-capture', 'fullscreen', 'clipboard-sanitized-write'].includes(permission)) {
            callback(true);
        } else {
            callback(false);
        }
    });

    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
        desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
            if (sources.length > 0) {
                callback({ video: sources[0] });
            } else {
                callback({});
            }
        }).catch(() => callback({}));
    });

    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
