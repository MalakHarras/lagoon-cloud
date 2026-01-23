# 🌊 Lagoon API Server - Cloud Deployment

**API Backend for Desktop (Electron) + Mobile (React Native) Apps**  
**Total size: ~80 KB** (API-only, no web UI)

---

## 🚀 Quick Deploy to DigitalOcean

### 1. Create Droplet
- **Ubuntu 22.04** / **Basic $12/mo** (2GB RAM)

### 2. SSH & Install Docker
```bash
ssh root@YOUR_SERVER_IP
apt update && apt install -y docker.io docker-compose git
systemctl enable docker
```

### 3. Clone & Configure
```bash
git clone https://github.com/MalakHarras/lagoon-cloud.git
cd lagoon-cloud
cp .env.example .env
nano .env  # Edit DATABASE_URL password & JWT_SECRET
```

### 4. Deploy!
```bash
docker-compose up -d
```

### 5. Test API
```bash
curl http://YOUR_SERVER_IP:3000
# Should return: {"success": true, "message": "Lagoon API Server", ...}
```

---

## 📁 Files Included
- `server/server.js` - Express API server (PostgreSQL)
- `db-postgres.js` - PostgreSQL database layer
- `docker-compose.yml` - PostgreSQL + App containers
- `Dockerfile` - Node.js 18 Alpine container

---

## ⚙️ Environment Variables
```env
POSTGRES_USER=lagoon
POSTGRES_PASSWORD=YOUR_STRONG_PASSWORD
POSTGRES_DB=lagoon
JWT_SECRET=your-secret-key-min-32-characters
PORT=3000
NODE_ENV=production
```

---

## 📱 Connect Your Apps

### Desktop App (Electron)
Update server URL in your Electron app config:
```javascript
const API_BASE_URL = 'http://YOUR_SERVER_IP:3000';
```

### Android App (React Native)
Edit `mobile/src/api/ApiService.ts`:
```typescript
const BASE_URL = 'http://YOUR_SERVER_IP:3000';
```
Then rebuild APK:
```bash
cd mobile
npm run build-apk
```

---

## 🔌 API Endpoints

- `POST /api/auth/login` - User authentication
- `GET /api/users` - User management
- `GET /api/products` - Products & brands
- `GET /api/stores` - Stores & groups
- `GET /api/snapshots` - Stock snapshots
- `GET /api/deliveries` - Deliveries
- `GET /api/tasks` - Task management
- `GET /api/route-schedules` - Weekly routes

Full API docs: See server/server.js

---

## 🔒 Security (Production)

1. **Firewall**: Only allow ports 22 (SSH) and 3000 (API)
   ```bash
   ufw allow 22
   ufw allow 3000
   ufw enable
   ```

2. **Strong passwords**: Change default DB password in .env

3. **SSL/HTTPS**: Install certificate (optional for API-only)
