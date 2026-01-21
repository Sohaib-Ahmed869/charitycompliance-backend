# Charity Compliance Platform - Backend API

## 🚀 Phase 1: Foundation Complete!

We've successfully implemented the core infrastructure for the multi-tenant charity compliance platform.

## 📁 Project Structure

```
backend/
├── src/
│   ├── config/
│   │   ├── database.js              # Router DB connection
│   │   └── encryption.js            # Master key management
│   ├── db/
│   │   ├── connectionManager.js     # Pod connection pool (LRU)
│   │   └── router.js                # Tenant lookup
│   ├── utils/
│   │   ├── encryption.js            # AES-256-GCM encryption
│   │   └── mongooseEncryptPlugin.js # Transparent encryption plugin
│   ├── middleware/
│   │   ├── auth.js                  # JWT authentication
│   │   ├── tenantResolver.js        # Tenant DB resolution
│   │   ├── rbac.js                  # Role-based access control
│   │   ├── errorHandler.js          # Error handling
│   │   └── rateLimiter.js           # Rate limiting
│   └── app.js                       # Express app setup
├── server.js                        # Entry point
├── package.json                     # Dependencies
└── env.example                      # Environment variables template
```

## 🔐 Environment Variables Required

Create a `.env` file in the `backend/` directory with these variables:

### **CRITICAL - Must Set:**
```env
# Router Database (MongoDB Atlas)
ROUTER_DB_URI=mongodb+srv://username:password@router-cluster.mongodb.net/router_db

# Master Encryption Key (64-character hex)
# Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
MASTER_KEY_HEX=your_64_character_hex_master_key_here

# JWT Secret (minimum 64 characters)
# Generate: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
JWT_SECRET=your_jwt_secret_key_here_minimum_64_characters
```

### **Required:**
```env
NODE_ENV=development
PORT=5000
JWT_EXPIRES_IN=7d
```

### **Optional (with defaults):**
```env
CORS_ORIGIN=http://localhost:5173
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
MAX_POOL_SIZE=10
MIN_POOL_SIZE=0
CONNECTION_IDLE_TIMEOUT_MS=600000
TENANT_CACHE_TTL=3600
```

See `env.example` for complete list.

## 🛠️ Installation

1. **Install Dependencies:**
   ```bash
   npm install
   ```

2. **Set Up Environment:**
   ```bash
   cp env.example .env
   # Edit .env with your values
   ```

3. **Generate Master Key:**
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   Copy the output to `MASTER_KEY_HEX` in `.env`

4. **Generate JWT Secret:**
   ```bash
   node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
   ```
   Copy the output to `JWT_SECRET` in `.env`

## 🚦 Running the Server

**Development:**
```bash
npm run dev
```

**Production:**
```bash
npm start
```

The server will start on `http://localhost:5000` (or your configured PORT).

## ✅ What's Implemented

### Core Infrastructure ✅
- ✅ Router Database connection
- ✅ Multi-tenant connection manager with LRU cache
- ✅ Tenant lookup and routing
- ✅ AES-256-GCM field-level encryption
- ✅ Mongoose encryption plugin (transparent encryption)
- ✅ JWT authentication middleware
- ✅ Tenant resolver middleware
- ✅ Role-based access control (RBAC)
- ✅ Centralized error handling
- ✅ Rate limiting
- ✅ Express app setup
- ✅ Graceful shutdown handling

### Security Features ✅
- ✅ Field-level encryption with unique keys per organization
- ✅ Master key encryption for org keys
- ✅ JWT token authentication
- ✅ Permission-based access control
- ✅ Rate limiting
- ✅ Input validation ready

## 📋 Next Steps (Phase 2)

1. **Router Database Schemas:**
   - `tenants` collection schema
   - `subscription_plans` collection schema
   - `organization_subscription` collection schema

2. **Authentication Routes:**
   - POST `/api/v1/auth/register` - Register organization
   - POST `/api/v1/auth/login` - Login
   - POST `/api/v1/auth/refresh` - Refresh token

3. **Platform Routes:**
   - Organization management
   - User management
   - Role management
   - Subscription management

## 🧪 Testing

Health check endpoint:
```bash
curl http://localhost:5000/health
```

Expected response:
```json
{
  "success": true,
  "message": "Charity Compliance API is running",
  "timestamp": "2026-01-20T...",
  "environment": "development"
}
```

## 📚 Documentation

- `IMPLEMENTATION_GUIDE.md` - Complete implementation guide
- `QUICK_REFERENCE.md` - Quick reference for developers

## 🔒 Security Notes

1. **NEVER commit `.env` file** - It contains sensitive keys
2. **Master Key** - Must be kept secure. If compromised, all org keys need re-encryption
3. **JWT Secret** - Must be unique and secure
4. **Router DB URI** - Contains database credentials, keep secure

## 🐛 Troubleshooting

**Error: "Router Database not connected"**
- Check `ROUTER_DB_URI` in `.env`
- Ensure MongoDB Atlas cluster is accessible
- Check network/firewall settings

**Error: "Invalid MASTER_KEY_HEX format"**
- Must be exactly 64 characters (32 bytes in hex)
- Generate new key using the command above

**Error: "JWT_SECRET environment variable is required"**
- Set `JWT_SECRET` in `.env`
- Must be at least 64 characters

## 📞 Support

For issues or questions, refer to the implementation guide or contact the development team.

---

**Status:** Phase 1 Complete ✅ | Ready for Phase 2 (Platform Infrastructure)
