let localStream = null;
const peerConnections = {};
const pendingIceCandidates = {};
const makingOffer = {};
const audioMonitors = {};
const speakingUsers = new Set();
let sharedAudioContext = null;
let socket = null;

const appState = {
    token: null,
    user: null,
    servers: [],
    activeServer: null,
    channels: [],
    activeChannelId: null,
    activeVoiceChannelId: null,
    members: [],
    onlineUsers: [],
    voiceChannels: {}
};

function getApiBase() {
    return window.EpigaeaConfig.getApiBase();
}

function getWsUrl() {
    return window.EpigaeaConfig.getWsUrl();
}

function showToast(message, isError = false) {
    const toast = document.getElementById('toast-banner');
    toast.textContent = message;
    toast.className = isError ? 'toast-banner error' : 'toast-banner';
    toast.style.display = 'block';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
        toast.style.display = 'none';
    }, 3500);
}

function closeModals() {
    document.getElementById('create-server-modal').style.display = 'none';
    document.getElementById('join-server-modal').style.display = 'none';
    document.getElementById('create-channel-modal').style.display = 'none';
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// --- Login ---

document.getElementById('login-form').addEventListener('submit', async function (event) {
    event.preventDefault();
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const errorEl = document.getElementById('login-error');
    errorEl.style.display = 'none';

    try {
        const response = await fetch(`${getApiBase()}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await response.json();

        if (data.success && data.token) {
            appState.token = data.token;
            try {
                document.getElementById('login-sound').play();
            } catch (e) {
                console.error('Could not play login sound:', e);
            }

            const loginContainer = document.querySelector('.login-container');
            const appWrapper = document.getElementById('app-wrapper');
            loginContainer.classList.add('fade-out');

            setTimeout(() => {
                loginContainer.style.display = 'none';
                appWrapper.style.display = 'flex';
                setTimeout(() => {
                    appWrapper.classList.add('fade-in');
                    establishWebSocket(data.token);
                }, 10);
            }, 350);
        } else {
            errorEl.textContent = data.message || 'Login failed';
            errorEl.style.display = 'block';
        }
    } catch (error) {
        console.error('Error:', error);
        errorEl.textContent = 'Could not reach server.';
        errorEl.style.display = 'block';
    }
});

// --- WebRTC Media Controls ---

async function addStreamToPeers(newStream) {
    document.getElementById('video-modal').style.display = 'flex';
    const videoTrack = newStream.getVideoTracks()[0];
    if (!videoTrack) return;

    let localVideo = document.getElementById('local-video');
    if (!localVideo) {
        localVideo = document.createElement('video');
        localVideo.id = 'local-video';
        localVideo.autoplay = true;
        localVideo.muted = true;
        document.getElementById('video-grid').appendChild(localVideo);
    }
    localVideo.srcObject = new MediaStream([videoTrack]);

    if (localStream) {
        const oldVideoTrack = localStream.getVideoTracks()[0];
        if (oldVideoTrack) {
            localStream.removeTrack(oldVideoTrack);
            oldVideoTrack.stop();
        }
        localStream.addTrack(videoTrack);
    } else {
        localStream = newStream;
    }

    for (const peer of Object.values(peerConnections)) {
        const sender = peer.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) {
            sender.replaceTrack(videoTrack);
        } else {
            peer.addTrack(videoTrack, localStream);
        }
    }
}

async function startCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        addStreamToPeers(stream);
    } catch (err) {
        showToast('Camera access denied.', true);
    }
}

async function startScreenShare() {
    try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        addStreamToPeers(stream);
    } catch (err) {
        showToast('Screen sharing canceled.', true);
    }
}

function getAudioContext() {
    if (!sharedAudioContext) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) sharedAudioContext = new AudioCtx();
    }
    if (sharedAudioContext && sharedAudioContext.state === 'suspended') {
        sharedAudioContext.resume().catch(() => {});
    }
    return sharedAudioContext;
}

function setUserSpeakingState(username, isSpeaking) {
    if (!username) return;
    if (isSpeaking) speakingUsers.add(username);
    else speakingUsers.delete(username);

    const participantEls = document.querySelectorAll(`.voice-participant[data-voice-user="${CSS.escape(username)}"]`);
    participantEls.forEach(el => {
        el.classList.toggle('speaking', isSpeaking);
        const icon = el.querySelector('.voice-wave-icon');
        if (icon) icon.classList.toggle('speaking', isSpeaking);
    });

    if (appState.user && username === appState.user.username) {
        const localWave = document.getElementById('local-mic-wave');
        const label = document.getElementById('mic-status-label');
        if (localWave) localWave.classList.toggle('speaking', isSpeaking);
        if (label && appState.activeVoiceChannelId) {
            label.textContent = isSpeaking ? 'Speaking (Mic Heard)' : 'Mic Ready';
        }
    }
}

function stopAudioMonitor(key) {
    const mon = audioMonitors[key];
    if (!mon) return;
    clearInterval(mon.timer);
    try { mon.source.disconnect(); } catch (_) {}
    delete audioMonitors[key];
    if (key === '__local__' && appState.user) {
        setUserSpeakingState(appState.user.username, false);
    } else {
        setUserSpeakingState(key, false);
    }
}

function startAudioActivityMonitor(key, stream, usernameForUi) {
    stopAudioMonitor(key);
    if (!stream || stream.getAudioTracks().length === 0) return;

    const ctx = getAudioContext();
    if (!ctx) return;

    try {
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.4;
        source.connect(analyser);

        const data = new Uint8Array(analyser.frequencyBinCount);
        let lastSpeaking = false;
        let holdUntil = 0;

        const timer = setInterval(() => {
            analyser.getByteFrequencyData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) sum += data[i];
            const avg = sum / data.length;
            const now = Date.now();
            if (avg > 10) {
                holdUntil = now + 260;
            }
            const isSpeaking = now < holdUntil;
            if (isSpeaking !== lastSpeaking) {
                lastSpeaking = isSpeaking;
                setUserSpeakingState(usernameForUi, isSpeaking);
            }
        }, 70);

        audioMonitors[key] = { source, analyser, timer };
    } catch (e) {
        console.warn('Could not start audio monitor:', e);
    }
}

function cleanupPeer(targetUser) {
    if (peerConnections[targetUser]) {
        peerConnections[targetUser].close();
        delete peerConnections[targetUser];
    }
    delete pendingIceCandidates[targetUser];
    delete makingOffer[targetUser];
    stopAudioMonitor(targetUser);

    const audioEl = document.getElementById('audio-' + targetUser);
    if (audioEl) audioEl.remove();
    const videoEl = document.getElementById('video-' + targetUser);
    if (videoEl) videoEl.remove();
}

function joinVoiceChannel(channelId) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (appState.activeVoiceChannelId === channelId) return;

    // Clean up any previous voice session cleanly
    if (appState.activeVoiceChannelId !== null) {
        leaveVoiceChannel();
    }

    getAudioContext();

    const voiceStatusBar = document.getElementById('voice-status-bar');
    const micLabel = document.getElementById('mic-status-label');

    navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
    })
        .then(stream => {
            localStream = stream;
            appState.activeVoiceChannelId = channelId;
            document.getElementById('leave-voice-btn').style.display = 'block';
            if (voiceStatusBar) voiceStatusBar.style.display = 'flex';
            if (micLabel) micLabel.textContent = 'Mic Ready';
            if (appState.user) {
                startAudioActivityMonitor('__local__', stream, appState.user.username);
            }
            socket.send(JSON.stringify({ type: 'join-voice', channelId }));
        })
        .catch(() => {
            // Allow joining voice presence even without microphone in headless/test environments
            appState.activeVoiceChannelId = channelId;
            document.getElementById('leave-voice-btn').style.display = 'block';
            if (voiceStatusBar) voiceStatusBar.style.display = 'flex';
            if (micLabel) micLabel.textContent = 'Listen Only (No Mic)';
            socket.send(JSON.stringify({ type: 'join-voice', channelId }));
        });
}

function leaveVoiceChannel() {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'leave-voice' }));
    }
    appState.activeVoiceChannelId = null;
    document.getElementById('leave-voice-btn').style.display = 'none';
    const voiceStatusBar = document.getElementById('voice-status-bar');
    if (voiceStatusBar) voiceStatusBar.style.display = 'none';
    stopAudioMonitor('__local__');

    for (const user of Object.keys(peerConnections)) {
        cleanupPeer(user);
    }
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
    }
}

async function sendOfferToPeer(targetUser, peer) {
    if (!peer || makingOffer[targetUser] || peer.signalingState !== 'stable') return;
    try {
        makingOffer[targetUser] = true;
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        socket.send(JSON.stringify({ type: 'webrtc-offer', target: targetUser, offer: peer.localDescription }));
    } catch (e) {
        console.error('Error creating WebRTC offer:', e);
    } finally {
        makingOffer[targetUser] = false;
    }
}

async function flushIceCandidates(targetUser, peer) {
    const queue = pendingIceCandidates[targetUser];
    if (!queue || queue.length === 0 || !peer.remoteDescription) return;
    while (queue.length > 0) {
        const candidate = queue.shift();
        try {
            await peer.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
            console.warn('Failed adding queued ICE candidate:', e);
        }
    }
}

function createPeerConnection(targetUser, isInitiator = false) {
    if (peerConnections[targetUser]) {
        cleanupPeer(targetUser);
    }

    const rtcConfig = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    };
    const peer = new RTCPeerConnection(rtcConfig);
    pendingIceCandidates[targetUser] = [];

    if (localStream) {
        localStream.getTracks().forEach(track => peer.addTrack(track, localStream));
    }

    // Ensure audio transceiver exists even if this user joined listen-only (no mic)
    const hasAudioSender = peer.getSenders().some(s => s.track && s.track.kind === 'audio');
    if (!hasAudioSender && isInitiator) {
        peer.addTransceiver('audio', { direction: 'recvonly' });
    }

    peer.onnegotiationneeded = async () => {
        await sendOfferToPeer(targetUser, peer);
    };

    peer.onicecandidate = (event) => {
        if (event.candidate) {
            socket.send(JSON.stringify({ type: 'webrtc-ice', target: targetUser, candidate: event.candidate }));
        }
    };

    peer.ontrack = (event) => {
        const track = event.track;
        const incomingStream = (event.streams && event.streams[0]) ? event.streams[0] : new MediaStream([track]);

        if (track.kind === 'audio') {
            let audioEl = document.getElementById('audio-' + targetUser);
            if (!audioEl) {
                audioEl = document.createElement('audio');
                audioEl.id = 'audio-' + targetUser;
                audioEl.autoplay = true;
                audioEl.playsInline = true;
                document.body.appendChild(audioEl);
            }
            audioEl.srcObject = incomingStream;
            audioEl.play().catch(err => console.warn('Remote audio play blocked:', err));
            startAudioActivityMonitor(targetUser, incomingStream, targetUser);
        } else if (track.kind === 'video') {
            let videoEl = document.getElementById('video-' + targetUser);
            if (!videoEl) {
                videoEl = document.createElement('video');
                videoEl.id = 'video-' + targetUser;
                videoEl.autoplay = true;
                videoEl.playsInline = true;
                document.getElementById('video-modal').style.display = 'flex';
                document.getElementById('video-grid').appendChild(videoEl);
            }
            videoEl.srcObject = incomingStream;
        }
    };

    peerConnections[targetUser] = peer;

    if (isInitiator) {
        sendOfferToPeer(targetUser, peer);
    }

    return peer;
}

// --- Rendering ---

function renderServerRail() {
    const listEl = document.getElementById('server-list');
    listEl.innerHTML = '';
    appState.servers.forEach(srv => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'server-pill' + (appState.activeServer && appState.activeServer.id === srv.id ? ' active' : '');
        btn.title = srv.name;
        btn.dataset.serverId = srv.id;
        const initials = srv.name
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map(w => w[0].toUpperCase())
            .join('') || 'S';
        btn.textContent = initials;
        btn.addEventListener('click', () => {
            socket.send(JSON.stringify({ type: 'select-server', serverId: srv.id }));
        });
        listEl.appendChild(btn);
    });
}

function renderSidebar() {
    const srv = appState.activeServer;
    const serverNameEl = document.getElementById('current-server-name');
    const roleBadgeEl = document.getElementById('role-badge');
    const inviteBoxEl = document.getElementById('invite-box');
    const addTextBtn = document.getElementById('add-text-channel-btn');
    const addVoiceBtn = document.getElementById('add-voice-channel-btn');

    if (!srv) {
        serverNameEl.textContent = 'No Server';
        roleBadgeEl.style.display = 'none';
        inviteBoxEl.style.display = 'none';
        addTextBtn.style.display = 'none';
        addVoiceBtn.style.display = 'none';
        return;
    }

    serverNameEl.textContent = srv.name;

    if (appState.user && appState.user.isGlobalAdmin) {
        roleBadgeEl.textContent = 'Global Admin';
        roleBadgeEl.style.display = 'inline-block';
    } else if (srv.canManage) {
        roleBadgeEl.textContent = 'Owner';
        roleBadgeEl.style.display = 'inline-block';
    } else {
        roleBadgeEl.style.display = 'none';
    }

    if (srv.canManage && srv.inviteCode) {
        document.getElementById('invite-code-text').textContent = srv.inviteCode;
        inviteBoxEl.style.display = 'flex';
        addTextBtn.style.display = 'inline-flex';
        addVoiceBtn.style.display = 'inline-flex';
    } else {
        inviteBoxEl.style.display = 'none';
        addTextBtn.style.display = 'none';
        addVoiceBtn.style.display = 'none';
    }

    const textListEl = document.getElementById('text-channel-list');
    const voiceListEl = document.getElementById('voice-channel-list');
    textListEl.innerHTML = '';
    voiceListEl.innerHTML = '';

    const textChannels = appState.channels.filter(c => c.type === 'TEXT');
    const voiceChannels = appState.channels.filter(c => c.type === 'VOICE');

    textChannels.forEach(ch => {
        const li = document.createElement('li');
        li.className = 'channel-item' + (appState.activeChannelId === ch.id ? ' active' : '');
        li.dataset.channelId = ch.id;

        const label = document.createElement('span');
        label.className = 'channel-label';
        label.textContent = `# ${ch.name}`;
        label.addEventListener('click', () => {
            appState.activeChannelId = ch.id;
            renderSidebar();
            updateChannelHeader();
            socket.send(JSON.stringify({ type: 'select-channel', channelId: ch.id }));
        });
        li.appendChild(label);

        if (srv.canManage && textChannels.length > 1) {
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'channel-del-btn';
            delBtn.title = 'Delete Channel';
            delBtn.textContent = '×';
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                socket.send(JSON.stringify({ type: 'delete-channel', serverId: srv.id, channelId: ch.id }));
            });
            li.appendChild(delBtn);
        }
        textListEl.appendChild(li);
    });

    voiceChannels.forEach(ch => {
        const li = document.createElement('li');
        li.className = 'channel-item voice-item' + (appState.activeVoiceChannelId === ch.id ? ' active' : '');
        li.dataset.channelId = ch.id;

        const row = document.createElement('div');
        row.className = 'voice-item-row';

        const label = document.createElement('span');
        label.className = 'channel-label';
        label.textContent = `\uD83D\uDD0A ${ch.name}`;
        label.addEventListener('click', () => joinVoiceChannel(ch.id));
        row.appendChild(label);

        if (srv.canManage) {
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'channel-del-btn';
            delBtn.title = 'Delete Voice Channel';
            delBtn.textContent = '×';
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                socket.send(JSON.stringify({ type: 'delete-channel', serverId: srv.id, channelId: ch.id }));
            });
            row.appendChild(delBtn);
        }

        const usersDiv = document.createElement('div');
        usersDiv.className = 'channel-users';
        const participants = appState.voiceChannels[String(ch.id)] || [];
        participants.forEach(pUser => {
            const pRow = document.createElement('div');
            const isSpeaking = speakingUsers.has(pUser);
            pRow.className = 'voice-participant' + (isSpeaking ? ' speaking' : '');
            pRow.dataset.voiceUser = pUser;

            const waveIcon = document.createElement('span');
            waveIcon.className = 'voice-wave-icon' + (isSpeaking ? ' speaking' : '');
            waveIcon.innerHTML = '<span></span><span></span><span></span>';
            pRow.appendChild(waveIcon);

            const nameEl = document.createElement('span');
            nameEl.textContent = pUser;
            pRow.appendChild(nameEl);

            usersDiv.appendChild(pRow);
        });

        li.appendChild(row);
        li.appendChild(usersDiv);
        voiceListEl.appendChild(li);
    });

    renderMembers();
    updateChannelHeader();
}

function renderMembers() {
    const userList = document.getElementById('user-list');
    userList.innerHTML = '';
    const onlineSet = new Set(appState.onlineUsers || []);

    const listToRender = (appState.members && appState.members.length > 0)
        ? appState.members
        : (appState.onlineUsers || []).map(u => ({ username: u, role: 'MEMBER', isGlobalAdmin: false }));

    listToRender.forEach(m => {
        const li = document.createElement('li');
        const isOnline = onlineSet.has(m.username);
        const dot = document.createElement('span');
        dot.className = isOnline ? 'status-dot online' : 'status-dot offline';
        li.appendChild(dot);

        const nameSpan = document.createElement('span');
        nameSpan.textContent = m.username;
        li.appendChild(nameSpan);

        if (m.isGlobalAdmin) {
            const tag = document.createElement('span');
            tag.className = 'member-tag admin';
            tag.textContent = 'ADMIN';
            li.appendChild(tag);
        } else if (m.role === 'OWNER') {
            const tag = document.createElement('span');
            tag.className = 'member-tag owner';
            tag.textContent = 'OWNER';
            li.appendChild(tag);
        }
        userList.appendChild(li);
    });
}

function updateChannelHeader() {
    const ch = appState.channels.find(c => c.id === appState.activeChannelId);
    document.getElementById('current-channel-name').textContent = ch ? ch.name : 'general';
    if (appState.user) {
        document.getElementById('current-user-label').textContent =
            appState.user.isGlobalAdmin ? `${appState.user.username} (Admin)` : appState.user.username;
    }
}

function appendChatMessage(msg) {
    const chatHistory = document.getElementById('chat-history');
    const msgDiv = document.createElement('div');
    msgDiv.className = 'chat-message';

    const timeStr = msg.timestamp
        ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '';

    const header = document.createElement('div');
    header.className = 'chat-msg-header';
    const author = document.createElement('strong');
    author.textContent = msg.username;
    header.appendChild(author);

    if (timeStr) {
        const ts = document.createElement('span');
        ts.className = 'chat-msg-time';
        ts.textContent = timeStr;
        header.appendChild(ts);
    }
    msgDiv.appendChild(header);

    const text = msg.message || '';
    const isImage = /^https?:\/\/.+\.(jpeg|jpg|gif|png|webp)(\?.*)?$/i.test(text.trim());
    if (isImage) {
        const img = document.createElement('img');
        img.src = text.trim();
        img.style.maxWidth = '100%';
        img.style.borderRadius = '10px';
        img.style.marginTop = '5px';
        msgDiv.appendChild(img);
    } else {
        const body = document.createElement('div');
        body.className = 'chat-msg-body';
        body.textContent = text;
        msgDiv.appendChild(body);
    }

    chatHistory.appendChild(msgDiv);
    chatHistory.scrollTop = chatHistory.scrollHeight;
}

function renderChatHistory(messages) {
    const chatHistory = document.getElementById('chat-history');
    chatHistory.innerHTML = '';
    (messages || []).forEach(appendChatMessage);
}

// --- WebSocket & UI Event Wiring ---

function sendChatMessage() {
    const chatInput = document.getElementById('chat-input');
    const text = chatInput.value.trim();
    if (!text || !socket || socket.readyState !== WebSocket.OPEN) return;
    if (!appState.activeChannelId) {
        showToast('Select a text channel first', true);
        return;
    }
    socket.send(JSON.stringify({
        type: 'chat',
        channelId: appState.activeChannelId,
        message: text
    }));
    chatInput.value = '';
}

function establishWebSocket(token) {
    socket = new WebSocket(getWsUrl());

    socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'join', token }));
    };

    socket.onmessage = async function (event) {
        try {
            const data = JSON.parse(event.data);

            if (data.type === 'init') {
                appState.user = data.user;
                appState.servers = data.servers || [];
                appState.activeServer = data.activeServer || data.server || null;
                appState.channels = data.channels || [];
                appState.activeChannelId = data.activeChannelId || null;
                appState.members = data.members || [];
                appState.onlineUsers = data.onlineUsers || [];
                appState.voiceChannels = data.voiceChannels || {};
                renderServerRail();
                renderSidebar();
                renderChatHistory(data.messages || []);
            } else if (data.type === 'server-state') {
                if (data.servers) {
                    appState.servers = data.servers;
                }
                appState.activeServer = data.server;
                appState.channels = data.channels || [];
                appState.activeChannelId = data.activeChannelId || null;
                appState.members = data.members || [];
                appState.onlineUsers = data.onlineUsers || [];
                appState.voiceChannels = data.voiceChannels || {};
                renderServerRail();
                renderSidebar();
                renderChatHistory(data.messages || []);
            } else if (data.type === 'server-updated') {
                if (appState.activeServer && data.server && appState.activeServer.id === data.server.id) {
                    appState.activeServer = data.server;
                    appState.channels = data.channels || [];
                    appState.members = data.members || [];
                    appState.onlineUsers = data.onlineUsers || [];
                    appState.voiceChannels = data.voiceChannels || {};
                    const idx = appState.servers.findIndex(s => s.id === data.server.id);
                    if (idx !== -1) appState.servers[idx] = data.server;
                    renderServerRail();
                    renderSidebar();
                }
            } else if (data.type === 'channel-history') {
                if (appState.activeServer && data.serverId === appState.activeServer.id) {
                    appState.activeChannelId = data.channelId;
                    renderSidebar();
                    renderChatHistory(data.messages || []);
                }
            } else if (data.type === 'chat') {
                if (appState.activeChannelId === data.channelId) {
                    appendChatMessage(data);
                }
            } else if (data.type === 'users') {
                if (appState.activeServer && data.serverId === appState.activeServer.id) {
                    appState.onlineUsers = data.list || [];
                    if (data.members) appState.members = data.members;
                    renderMembers();
                }
            } else if (data.type === 'voice-users') {
                if (appState.activeServer && data.serverId === appState.activeServer.id) {
                    appState.voiceChannels = data.channels || {};
                    renderSidebar();
                }
            } else if (data.type === 'invite-updated') {
                if (appState.activeServer && data.serverId === appState.activeServer.id) {
                    appState.activeServer.inviteCode = data.inviteCode;
                    renderSidebar();
                    showToast(`New invite code: ${data.inviteCode}`);
                }
            } else if (data.type === 'voice-kicked') {
                if (appState.activeVoiceChannelId === data.channelId) {
                    leaveVoiceChannel();
                    showToast('Voice channel was deleted by an admin', true);
                }
            } else if (data.type === 'error') {
                showToast(data.message || 'Action failed', true);
            } else if (data.type === 'user-joined-voice') {
                createPeerConnection(data.username, true);
            } else if (data.type === 'user-left-voice') {
                cleanupPeer(data.username);
            } else if (data.type === 'webrtc-offer') {
                let peer = peerConnections[data.sender];
                if (!peer) peer = createPeerConnection(data.sender, false);

                if (makingOffer[data.sender] || peer.signalingState !== 'stable') {
                    await peer.setLocalDescription({ type: 'rollback' });
                }
                await peer.setRemoteDescription(new RTCSessionDescription(data.offer));
                await flushIceCandidates(data.sender, peer);

                const answer = await peer.createAnswer();
                await peer.setLocalDescription(answer);
                socket.send(JSON.stringify({ type: 'webrtc-answer', target: data.sender, answer: peer.localDescription }));
            } else if (data.type === 'webrtc-answer') {
                const peer = peerConnections[data.sender];
                if (peer) {
                    await peer.setRemoteDescription(new RTCSessionDescription(data.answer));
                    await flushIceCandidates(data.sender, peer);
                }
            } else if (data.type === 'webrtc-ice') {
                const peer = peerConnections[data.sender];
                if (peer && peer.remoteDescription) {
                    await peer.addIceCandidate(new RTCIceCandidate(data.candidate));
                } else {
                    if (!pendingIceCandidates[data.sender]) pendingIceCandidates[data.sender] = [];
                    pendingIceCandidates[data.sender].push(data.candidate);
                }
            }
        } catch (e) {
            console.error('Error processing message:', e);
        }
    };
}

// Wire static DOM controls once
document.getElementById('chat-input').addEventListener('keypress', function (e) {
    if (e.key === 'Enter') {
        sendChatMessage();
    }
});

document.getElementById('send-btn').addEventListener('click', sendChatMessage);

document.getElementById('open-create-server-btn').addEventListener('click', () => {
    document.getElementById('new-server-name').value = '';
    document.getElementById('create-server-modal').style.display = 'flex';
});

document.getElementById('open-join-server-btn').addEventListener('click', () => {
    document.getElementById('join-invite-code').value = '';
    document.getElementById('join-server-modal').style.display = 'flex';
});

document.getElementById('add-text-channel-btn').addEventListener('click', () => {
    document.getElementById('new-channel-type').value = 'TEXT';
    document.getElementById('create-channel-modal-title').textContent = 'Create Text Channel';
    document.getElementById('new-channel-name').value = '';
    document.getElementById('create-channel-modal').style.display = 'flex';
});

document.getElementById('add-voice-channel-btn').addEventListener('click', () => {
    document.getElementById('new-channel-type').value = 'VOICE';
    document.getElementById('create-channel-modal-title').textContent = 'Create Voice Channel';
    document.getElementById('new-channel-name').value = '';
    document.getElementById('create-channel-modal').style.display = 'flex';
});

document.getElementById('create-server-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('new-server-name').value.trim();
    if (!name || !socket) return;
    socket.send(JSON.stringify({ type: 'create-server', name }));
    closeModals();
});

document.getElementById('join-server-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const inviteCode = document.getElementById('join-invite-code').value.trim();
    if (!inviteCode || !socket) return;
    socket.send(JSON.stringify({ type: 'join-server', inviteCode }));
    closeModals();
});

document.getElementById('create-channel-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!appState.activeServer || !socket) return;
    const name = document.getElementById('new-channel-name').value.trim();
    const channelType = document.getElementById('new-channel-type').value;
    if (!name) return;
    socket.send(JSON.stringify({
        type: 'create-channel',
        serverId: appState.activeServer.id,
        name,
        channelType
    }));
    closeModals();
});

document.getElementById('copy-invite-btn').addEventListener('click', () => {
    const code = document.getElementById('invite-code-text').textContent;
    if (navigator.clipboard && code) {
        navigator.clipboard.writeText(code).then(() => showToast(`Copied code: ${code}`));
    } else if (code) {
        showToast(`Room code: ${code}`);
    }
});

document.getElementById('regen-invite-btn').addEventListener('click', () => {
    if (!appState.activeServer || !socket) return;
    socket.send(JSON.stringify({ type: 'regenerate-invite', serverId: appState.activeServer.id }));
});

document.getElementById('toggle-video-view').addEventListener('click', () => {
    const videoGrid = document.getElementById('video-grid');
    videoGrid.style.display = videoGrid.style.display === 'none' ? 'grid' : 'none';
});
