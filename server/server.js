// Lagoon Server - Cloud Deployment (PostgreSQL Only)
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const Database = require('../db-postgres');
const db = new Database(process.env.DATABASE_URL);

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'lagoon-secret-key-change-in-production';

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '50mb' }));

// API-only server for desktop and mobile apps
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Lagoon API Server',
    version: '2.0.0',
    database: 'PostgreSQL',
    endpoints: {
      auth: '/api/auth/*',
      users: '/api/users/*',
      products: '/api/products/*',
      stores: '/api/stores/*',
      snapshots: '/api/snapshots/*',
      deliveries: '/api/deliveries/*',
      tasks: '/api/tasks/*',
      routes: '/api/route-schedules/*'
    }
  });
});

// JWT Authentication Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ success: false, error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    req.user = user;
    next();
  });
};

// ============ DIAGNOSTIC ROUTES ============
app.get('/api/diagnostic/snapshots', authenticateToken, async (req, res) => {
  try {
    const orphaned = await db.query(`
      SELECT s.id, s.store_id, s.product_id, s.date,
        CASE WHEN st.id IS NULL THEN 'Missing Store' ELSE NULL END as store_error,
        CASE WHEN p.id IS NULL THEN 'Missing Product' ELSE NULL END as product_error
      FROM stock_snapshot s
      LEFT JOIN stores st ON st.id = s.store_id
      LEFT JOIN products p ON p.id = s.product_id
      WHERE st.id IS NULL OR p.id IS NULL
    `);
    
    const total = await db.query('SELECT COUNT(*) as count FROM stock_snapshot');
    const withJoins = await db.query(`
      SELECT COUNT(*) as count FROM stock_snapshot s
      JOIN products p ON p.id = s.product_id
      JOIN stores st ON st.id = s.store_id
    `);
    
    res.json({
      success: true,
      total: total[0].count,
      withJoins: withJoins[0].count,
      orphaned: orphaned
    });
  } catch (error) {
    console.error('[Diagnostic] Error:', error);
    res.json({ success: false, error: error.message });
  }
});

app.get('/api/diagnostic/user-debug', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Get user info
    const userInfo = await db.query('SELECT id, username, full_name, role FROM users WHERE id = $1', [userId]);
    
    // Get route schedules for user
    const schedules = await db.query(
      `SELECT id, store_id, day_of_week FROM route_schedules WHERE user_id = $1`,
      [userId]
    );
    
    // Get recent snapshots for user
    const snapshots = await db.query(
      `SELECT id, store_id, product_id, date, qty FROM stock_snapshot WHERE user_id = $1 ORDER BY date DESC LIMIT 10`,
      [userId]
    );
    
    // Get visit logs for user
    const visits = await db.query(
      `SELECT id, route_schedule_id, store_id, visit_date, is_completed FROM visit_logs WHERE user_id = $1 ORDER BY visit_date DESC LIMIT 10`,
      [userId]
    );
    
    res.json({
      success: true,
      user: userInfo[0],
      routeSchedules: schedules,
      recentSnapshots: snapshots,
      recentVisits: visits,
      totalSchedules: schedules.length,
      totalSnapshots: snapshots.length,
      totalVisits: visits.length
    });
  } catch (error) {
    console.error('[Diagnostic User Debug] Error:', error);
    res.json({ success: false, error: error.message });
  }
});

// ============ AUTH ROUTES ============
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await db.authenticateUser(username, password);
    
    if (result.success) {
      const token = jwt.sign(
        { id: result.user.id, username: result.user.username, role: result.user.role },
        JWT_SECRET
      );
      res.json({ success: true, token, user: result.user });
    } else {
      res.json({ success: false, error: result.error });
    }
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const users = await db.query('SELECT id, username, full_name, role, manager_id FROM users WHERE id = $1', [req.user.id]);
    if (users.length > 0) {
      res.json({ success: true, user: users[0] });
    } else {
      res.json({ success: false, error: 'User not found' });
    }
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Token refresh - issues a new token using a still-valid token
app.post('/api/auth/refresh', authenticateToken, async (req, res) => {
  try {
    // Verify user still exists in DB
    const users = await db.query('SELECT id, username, role FROM users WHERE id = $1', [req.user.id]);
    if (users.length === 0) {
      return res.status(401).json({ success: false, error: 'User not found' });
    }
    const user = users[0];
    const newToken = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET
    );
    res.json({ success: true, token: newToken });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============ USER ROUTES ============
app.get('/api/users', authenticateToken, async (req, res) => {
  try {
    const users = await db.getUsers();
    res.json({ success: true, data: users });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/users', authenticateToken, async (req, res) => {
  try {
    const canCreate = await db.hasPermission(req.user.id, 'users.create');
    if (!canCreate) {
      return res.status(403).json({ success: false, error: 'ليس لديك صلاحية لإضافة مستخدمين' });
    }
    const result = await db.addUser(req.body, req.user.role);
    res.json({ success: true, data: result });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.put('/api/users/:id', authenticateToken, async (req, res) => {
  try {
    const canEdit = await db.hasPermission(req.user.id, 'users.edit');
    if (!canEdit) {
      return res.status(403).json({ success: false, error: 'ليس لديك صلاحية لتعديل المستخدمين' });
    }
    const result = await db.updateUser({ ...req.body, id: parseInt(req.params.id) }, req.user.role);
    res.json({ success: true, data: result });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.delete('/api/users/:id', authenticateToken, async (req, res) => {
  try {
    const canDelete = await db.hasPermission(req.user.id, 'users.delete');
    if (!canDelete) {
      return res.status(403).json({ success: false, error: 'ليس لديك صلاحية لحذف المستخدمين' });
    }
    await db.deleteUser(parseInt(req.params.id), req.user.role);
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.get('/api/users/managers', authenticateToken, async (req, res) => {
  try {
    const managers = await db.getManagers();
    res.json({ success: true, data: managers });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.get('/api/users/sales-team', authenticateToken, async (req, res) => {
  try {
    const team = await db.getSalesTeam();
    res.json({ success: true, data: team });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============ PRODUCTS ROUTES ============
app.get('/api/products', authenticateToken, async (req, res) => {
  try {
    const products = await db.getProducts();
    res.json({ success: true, data: products });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/products', authenticateToken, async (req, res) => {
  try {
    const result = await db.addProduct(req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.put('/api/products/:id', authenticateToken, async (req, res) => {
  try {
    const result = await db.updateProduct({ ...req.body, id: parseInt(req.params.id) });
    res.json({ success: true, data: result });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.delete('/api/products/:id', authenticateToken, async (req, res) => {
  try {
    await db.deleteProduct(parseInt(req.params.id));
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============ BRANDS ROUTES ============
app.get('/api/brands', authenticateToken, async (req, res) => {
  try {
    const brands = await db.getBrands();
    res.json({ success: true, data: brands });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/brands', authenticateToken, async (req, res) => {
  try {
    const result = await db.addBrand(req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/brands/get-or-create', authenticateToken, async (req, res) => {
  try {
    console.log('[Server] Get or create brand request body:', req.body);
    if (!req.body.name || !req.body.name.trim()) {
      console.log('[Server] No brand name provided');
      return res.json({ success: false, error: 'Brand name is required' });
    }
    console.log('[Server] Get or create brand:', req.body.name.trim());
    const result = await db.getOrCreateBrand(req.body.name.trim());
    console.log('[Server] Brand result:', result);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('[Server] Brand get-or-create error:', error);
    res.json({ success: false, error: error.message });
  }
});

app.put('/api/brands/:id', authenticateToken, async (req, res) => {
  try {
    const result = await db.updateBrand({ ...req.body, id: parseInt(req.params.id) });
    res.json({ success: true, data: result });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.delete('/api/brands/:id', authenticateToken, async (req, res) => {
  try {
    await db.deleteBrand(parseInt(req.params.id));
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============ STORES ROUTES ============
app.get('/api/stores', authenticateToken, async (req, res) => {
  try {
    const stores = await db.getStores();
    res.json({ success: true, data: stores });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/stores', authenticateToken, async (req, res) => {
  try {
    const result = await db.addStore(req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.put('/api/stores/:id', authenticateToken, async (req, res) => {
  try {
    const result = await db.updateStore({ ...req.body, id: parseInt(req.params.id) });
    res.json({ success: true, data: result });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.delete('/api/stores/:id', authenticateToken, async (req, res) => {
  try {
    await db.deleteStore(parseInt(req.params.id));
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============ STORE GROUPS ROUTES ============
app.get('/api/store-groups', authenticateToken, async (req, res) => {
  try {
    const groups = await db.getStoreGroups();
    res.json({ success: true, data: groups });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/store-groups', authenticateToken, async (req, res) => {
  try {
    const result = await db.addStoreGroup(req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/store-groups/get-or-create', authenticateToken, async (req, res) => {
  try {
    console.log('[Server] Get or create store group request body:', req.body);
    if (!req.body.name || !req.body.name.trim()) {
      console.log('[Server] No store group name provided');
      return res.json({ success: false, error: 'Store group name is required' });
    }
    console.log('[Server] Get or create store group:', req.body.name.trim());
    const result = await db.getOrCreateStoreGroup(req.body.name.trim(), req.body.code || '');
    console.log('[Server] Store group result:', result);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('[Server] Store group get-or-create error:', error);
    res.json({ success: false, error: error.message });
  }
});

app.put('/api/store-groups/:id', authenticateToken, async (req, res) => {
  try {
    const result = await db.updateStoreGroup({ ...req.body, id: parseInt(req.params.id) });
    res.json({ success: true, data: result });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.delete('/api/store-groups/:id', authenticateToken, async (req, res) => {
  try {
    await db.deleteStoreGroup(parseInt(req.params.id));
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============ SNAPSHOTS ROUTES ============
app.get('/api/snapshots', authenticateToken, async (req, res) => {
  try {
    const { store_id, product_id, start_date, end_date } = req.query;
    const snapshots = await db.getSnapshotsAll(
      store_id ? parseInt(store_id) : null,
      product_id ? parseInt(product_id) : null,
      start_date,
      end_date
    );
    // Always return consistent format
    res.json({ success: true, data: snapshots || [] });
  } catch (error) {
    console.error('[GET /api/snapshots] Error:', error.message);
    res.json({ success: false, data: [], error: error.message });
  }
});

app.post('/api/snapshots', authenticateToken, async (req, res) => {
  try {
    console.log('[POST /api/snapshots] Received snapshot data:', {
      store_id: req.body.store_id,
      product_id: req.body.product_id,
      date: req.body.date,
      qty: req.body.qty,
      userId: req.user.id,
      userName: req.user.username
    });
    
    const data = { ...req.body };
    // Convert competitor_prices to JSON string if it's an object/array (for backwards compatibility)
    // If it's already a string, leave it as is
    if (data.competitor_prices && typeof data.competitor_prices !== 'string') {
      data.competitor_prices = JSON.stringify(data.competitor_prices);
    }
    const result = await db.addSnapshot(data, req.user.id);
    console.log('[POST /api/snapshots] Snapshot created with ID:', result.id);
    
    // Mark visit complete if applicable
    if (req.body.store_id && req.body.date) {
      console.log(`[Snapshot] Marking visit complete: storeId=${req.body.store_id}, userId=${req.user.id}, date=${req.body.date}`);
      const markResult = await db.markVisitCompleteFromSnapshot(req.body.store_id, req.user.id, req.body.date);
      console.log(`[Snapshot] Mark visit result:`, markResult);
    }
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('[POST /api/snapshots] Error:', error);
    res.json({ success: false, error: error.message });
  }
});

app.delete('/api/snapshots/:id', authenticateToken, async (req, res) => {
  try {
    // Check permission from database instead of hardcoded role check
    const canDelete = await db.hasPermission(req.user.id, 'snapshots.delete');
    if (!canDelete) {
      return res.status(403).json({ success: false, error: 'ليس لديك صلاحية لحذف هذا السجل' });
    }
    await db.deleteSnapshot(parseInt(req.params.id));
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============ DELIVERIES ROUTES ============
app.get('/api/deliveries', authenticateToken, async (req, res) => {
  try {
    const { store_id, product_id, start_date, end_date } = req.query;
    const deliveries = await db.getDeliveriesAll(
      store_id ? parseInt(store_id) : null,
      product_id ? parseInt(product_id) : null,
      start_date,
      end_date
    );
    res.json({ success: true, data: deliveries });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/deliveries', authenticateToken, async (req, res) => {
  try {
    const result = await db.addDelivery(req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.delete('/api/deliveries/:id', authenticateToken, async (req, res) => {
  try {
    await db.deleteDelivery(parseInt(req.params.id));
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============ RETURNS ROUTES ============
app.get('/api/returns', authenticateToken, async (req, res) => {
  try {
    const { store_id, product_id, start_date, end_date } = req.query;
    const returns = await db.getReturnsAll(
      store_id ? parseInt(store_id) : null,
      product_id ? parseInt(product_id) : null,
      start_date,
      end_date
    );
    res.json({ success: true, data: returns });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/returns', authenticateToken, async (req, res) => {
  try {
    const data = { ...req.body, user_id: req.user.id };
    const result = await db.addReturn(data);
    res.json({ success: true, data: result });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.delete('/api/returns/:id', authenticateToken, async (req, res) => {
  try {
    await db.deleteReturn(parseInt(req.params.id));
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============ TASKS ROUTES ============
app.get('/api/tasks', authenticateToken, async (req, res) => {
  try {
    // Convert string query params to proper types
    const filters = { ...req.query };
    if (filters.assignedTo) filters.assignedTo = parseInt(filters.assignedTo);
    if (filters.assignedBy) filters.assignedBy = parseInt(filters.assignedBy);
    if (filters.limit) filters.limit = parseInt(filters.limit);
    if (filters.offset) filters.offset = parseInt(filters.offset);
    
    const tasks = await db.getTasks(req.user.id, filters);
    res.json({ success: true, data: tasks });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.get('/api/tasks/my', authenticateToken, async (req, res) => {
  try {
    const tasks = await db.getMyTasks(req.user.id);
    res.json({ success: true, data: tasks });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.get('/api/tasks/stats', authenticateToken, async (req, res) => {
  try {
    const stats = await db.getTaskStats(req.user.id, req.user.role);
    res.json({ success: true, data: stats });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.get('/api/tasks/:id', authenticateToken, async (req, res) => {
  try {
    const task = await db.getTaskById(parseInt(req.params.id));
    res.json({ success: true, data: task });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/tasks', authenticateToken, async (req, res) => {
  try {
    const result = await db.addTask(req.body, req.user.id, req.user.role);
    res.json({ success: true, data: result });
  } catch (error) {
    res.json({ success: false, error: error.message, code: error.code });
  }
});

app.put('/api/tasks/:id', authenticateToken, async (req, res) => {
  try {
    const result = await db.updateTask({ ...req.body, id: parseInt(req.params.id) }, req.user.id, req.user.role);
    res.json({ success: true, data: result });
  } catch (error) {
    res.json({ success: false, error: error.message, code: error.code });
  }
});

// Update task status only (for mobile app quick status changes)
app.put('/api/tasks/:id/status', authenticateToken, async (req, res) => {
  try {
    const result = await db.updateTask({ status: req.body.status, id: parseInt(req.params.id) }, req.user.id, req.user.role);
    res.json({ success: true, data: result });
  } catch (error) {
    res.json({ success: false, error: error.message, code: error.code });
  }
});

app.delete('/api/tasks/:id', authenticateToken, async (req, res) => {
  try {
    await db.deleteTask(parseInt(req.params.id), req.user.id, req.user.role);
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, error: error.message, code: error.code });
  }
});

app.get('/api/tasks/:id/comments', authenticateToken, async (req, res) => {
  try {
    const comments = await db.getTaskComments(parseInt(req.params.id));
    res.json({ success: true, data: comments });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/tasks/:id/comments', authenticateToken, async (req, res) => {
  try {
    const result = await db.addTaskComment(parseInt(req.params.id), req.user.id, req.body.comment);
    res.json({ success: true, data: result });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============ TEAM ROUTES ============
app.get('/api/team/members', authenticateToken, async (req, res) => {
  try {
    const members = await db.getTeamMembers(req.user.id);
    res.json({ success: true, data: members });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.get('/api/team/subordinates', authenticateToken, async (req, res) => {
  try {
    const subordinates = await db.getAllSubordinatesFlat(req.user.id);
    res.json({ success: true, data: subordinates });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.get('/api/team/hierarchy', authenticateToken, async (req, res) => {
  try {
    // Use manager_id from query if provided, otherwise use current user's ID
    const managerId = req.query.manager_id ? parseInt(req.query.manager_id) : req.user.id;
    console.log(`[HIERARCHY] Getting direct subordinates for manager_id=${managerId}`);
    const hierarchy = await db.getDirectSubordinatesOnly(managerId);
    console.log(`[HIERARCHY] Returned ${hierarchy.length} direct subordinates:`, hierarchy.map(h => ({id: h.id, name: h.full_name})));
    res.json({ success: true, data: hierarchy });
  } catch (error) {
    console.error(`[HIERARCHY] Error:`, error);
    res.json({ success: false, error: error.message });
  }
});

// ============ NOTIFICATIONS ROUTES ============
app.get('/api/notifications', authenticateToken, async (req, res) => {
  try {
    const notifications = await db.getNotifications(req.user.id, req.query.unread === 'true');
    res.json({ success: true, data: notifications });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.get('/api/notifications/count', authenticateToken, async (req, res) => {
  try {
    const count = await db.getUnreadNotificationCount(req.user.id);
    res.json({ success: true, data: { count } });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.put('/api/notifications/:id/read', authenticateToken, async (req, res) => {
  try {
    await db.markNotificationRead(parseInt(req.params.id), req.user.id);
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.put('/api/notifications/read-all', authenticateToken, async (req, res) => {
  try {
    await db.markAllNotificationsRead(req.user.id);
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============ ROUTE SCHEDULES ============
app.get('/api/route-schedules', authenticateToken, async (req, res) => {
  try {
    const userId = req.query.user_id ? parseInt(req.query.user_id) : null;
    console.log(`[GET /api/route-schedules] Request from user ${req.user.id} (${req.user.username}), querying userId=${userId}`);
    const schedules = await db.getRouteSchedules(userId);
    console.log(`[GET /api/route-schedules] Returning ${schedules.length} schedules`);
    if (schedules.length > 0) {
      console.log(`[GET /api/route-schedules] First 2 schedules:`, schedules.slice(0, 2).map(s => ({ store_name: s.store_name, visit_date: s.visit_date, is_completed: s.is_completed })));
      // Log ALL schedules with their completion status
      console.log(`[GET /api/route-schedules] ALL SCHEDULES:`, schedules.map(s => ({ 
        id: s.id, 
        store_id: s.store_id,
        store_name: s.store_name, 
        visit_date: s.visit_date, 
        is_completed: s.is_completed 
      })));
    }
    res.json({ success: true, data: schedules });
  } catch (error) {
    console.error(`[GET /api/route-schedules] Error:`, error);
    res.json({ success: false, error: error.message });
  }
});

app.get('/api/route-schedules/my', authenticateToken, async (req, res) => {
  try {
    const schedules = await db.getUserWeeklyScheduleWithVisits(req.user.id);
    res.json({ success: true, data: schedules });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.get('/api/route-schedules/my-visits', authenticateToken, async (req, res) => {
  try {
    // Get visits based on snapshots (fallback when no route schedules exist)
    const cairoOffset = 2 * 60 * 60 * 1000;
    const nowUTC = new Date();
    const nowCairo = new Date(nowUTC.getTime() + cairoOffset);
    
    // Get 7-day window
    const dayDates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(nowCairo);
      d.setUTCDate(nowCairo.getUTCDate() + i);
      const year = d.getUTCFullYear();
      const month = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      dayDates.push(`${year}-${month}-${day}`);
    }
    
    // Get snapshots for this user in the 7-day window
    const snapshots = await db.query(`
      SELECT DISTINCT s.id, s.store_id, s.date, st.name as store_name, st.code as store_code
      FROM stock_snapshot s
      JOIN stores st ON st.id = s.store_id
      WHERE s.user_id = $1
        AND s.date = ANY($2)
      ORDER BY s.date, st.name
    `, [req.user.id, dayDates]);
    
    // Convert to route schedule format for consistency
    const visits = snapshots.map(s => ({
      id: s.id,
      store_id: s.store_id,
      store_name: s.store_name,
      store_code: s.store_code,
      visit_date: s.date,
      is_completed: 1,
      source: 'snapshot'
    }));
    
    console.log(`[GET /api/route-schedules/my-visits] Found ${visits.length} visits from snapshots`);
    res.json({ success: true, data: visits });
  } catch (error) {
    console.error('[GET /api/route-schedules/my-visits] Error:', error);
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/route-schedules/init-defaults', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    console.log(`[Init Defaults] Creating default routes for user ${userId}`);
    
    // Get all stores
    const stores = await db.query('SELECT id FROM stores');
    console.log(`[Init Defaults] Found ${stores.length} stores`);
    
    // Create a schedule for each store on each day of week (cycle through stores)
    let schedulesCreated = 0;
    const daysOfWeek = [0, 1, 2, 3, 4, 5, 6]; // Sunday to Saturday
    
    for (let i = 0; i < stores.length && i < daysOfWeek.length; i++) {
      const storeId = stores[i].id;
      const dayOfWeek = daysOfWeek[i];
      
      // Check if already exists
      const existing = await db.query(
        'SELECT id FROM route_schedules WHERE user_id = $1 AND store_id = $2 AND day_of_week = $3',
        [userId, storeId, dayOfWeek]
      );
      
      if (existing.length === 0) {
        await db.execute(
          `INSERT INTO route_schedules (user_id, store_id, day_of_week) VALUES ($1, $2, $3)`,
          [userId, storeId, dayOfWeek]
        );
        schedulesCreated++;
        console.log(`[Init Defaults] Created schedule: user=${userId}, store=${storeId}, day=${dayOfWeek}`);
      }
    }
    
    res.json({
      success: true,
      message: `Created ${schedulesCreated} default route schedules`,
      schedulesCreated
    });
  } catch (error) {
    console.error('[Init Defaults] Error:', error);
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/route-schedules', authenticateToken, async (req, res) => {
  try {
    const result = await db.addRouteSchedule(req.body, req.user.id);
    res.json({ success: true, data: result });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.delete('/api/route-schedules/:id', authenticateToken, async (req, res) => {
  try {
    const result = await db.deleteRouteSchedule(parseInt(req.params.id));
    res.json({ success: true, data: result });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/route-schedules/:id/toggle-visit', authenticateToken, async (req, res) => {
  try {
    const result = await db.toggleVisitComplete(parseInt(req.params.id), req.body.visit_date, req.user.id);
    res.json({ success: true, data: result });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============ COMPETITORS ROUTES ============
app.get('/api/competitors', authenticateToken, async (req, res) => {
  try {
    const competitors = await db.getAllCompetitors();
    res.json({ success: true, data: competitors });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.get('/api/competitors/product/:productId', authenticateToken, async (req, res) => {
  try {
    const competitors = await db.getCompetitors(parseInt(req.params.productId));
    res.json({ success: true, data: competitors });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/competitors', authenticateToken, async (req, res) => {
  try {
    const result = await db.addCompetitor(req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.put('/api/competitors/:id', authenticateToken, async (req, res) => {
  try {
    const result = await db.updateCompetitor({ ...req.body, id: parseInt(req.params.id) });
    res.json({ success: true, data: result });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.delete('/api/competitors/:id', authenticateToken, async (req, res) => {
  try {
    await db.deleteCompetitor(parseInt(req.params.id));
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============ TURNOVER ROUTES ============
app.get('/api/turnover', authenticateToken, async (req, res) => {
  try {
    const { store_id, product_id, start_date, end_date } = req.query;
    const result = await db.calculateTurnover(
      parseInt(store_id),
      parseInt(product_id),
      start_date,
      end_date
    );
    res.json(result);
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============ KPI ROUTES ============
app.get('/api/kpi/my-stats', authenticateToken, async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const stats = await db.getUserKPIStats(req.user.id, start_date, end_date);
    res.json({ success: true, data: stats });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.get('/api/kpi/user-stats', authenticateToken, async (req, res) => {
  try {
    const { user_id, start_date, end_date } = req.query;
    const stats = await db.getUserKPIStats(parseInt(user_id), start_date, end_date);
    res.json({ success: true, data: stats });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============ TEAM ADDITIONAL ROUTES ============
app.get('/api/team/all-subordinates', authenticateToken, async (req, res) => {
  try {
    const subordinates = await db.getAllSubordinatesFlat(req.user.id);
    res.json({ success: true, data: subordinates });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============ ROUTE SCHEDULES ADDITIONAL ============
app.get('/api/route-schedules/visit-count', authenticateToken, async (req, res) => {
  try {
    const userId = req.query.user_id ? parseInt(req.query.user_id) : req.user.id;
    const count = await db.getMonthlyVisitCount(userId);
    res.json({ success: true, data: count });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============ REPORTS ROUTES ============
app.get('/api/reports/snapshots-matrix', authenticateToken, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const matrix = await db.getSnapshotsMatrixReport(startDate, endDate);
    res.json({ success: true, data: matrix });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.get('/api/reports/deliveries-matrix', authenticateToken, async (req, res) => {
  try {
    const { startDate, endDate, store_id } = req.query;
    const matrix = await db.getDeliveriesMatrixReport(startDate, endDate, store_id ? parseInt(store_id) : null);
    res.json({ success: true, data: matrix });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.get('/api/reports/competitors', authenticateToken, async (req, res) => {
  try {
    const { startDate, endDate, storeGroupId } = req.query;
    const data = await db.getCompetitorsReport(startDate, endDate, storeGroupId ? parseInt(storeGroupId) : null);
    res.json({ success: true, data });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Reports visits - actual visit logs count by user
app.get('/api/reports/visits', authenticateToken, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const data = await db.getVisitsReport(startDate, endDate);
    res.json({ success: true, data });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Reports deliveries - actual delivery count by user
app.get('/api/reports/deliveries', authenticateToken, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const data = await db.getDeliveriesReport(startDate, endDate);
    res.json({ success: true, data });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============ TASKS METRICS ============
app.get('/api/tasks/metrics', authenticateToken, async (req, res) => {
  try {
    const { user_id, start_date, end_date } = req.query;
    
    // If no user_id provided, use authenticated user's ID
    const targetUserId = user_id ? parseInt(user_id) : req.user.id;
    
    if (isNaN(targetUserId)) {
      return res.json({ success: false, error: 'Invalid user_id' });
    }
    
    const metrics = await db.getTaskMetrics(targetUserId, start_date, end_date);
    res.json({ success: true, data: metrics });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============ PERMISSION ROUTES ============

// Get current user's permissions
app.get('/api/permissions/my', authenticateToken, async (req, res) => {
  try {
    const permissions = await db.getUserPermissions(req.user.id);
    res.json({ success: true, data: permissions });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Check if current user has a specific permission
app.get('/api/permissions/check/:key', authenticateToken, async (req, res) => {
  try {
    const hasPermission = await db.hasPermission(req.user.id, req.params.key);
    res.json({ success: true, data: { allowed: hasPermission } });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Get all role permissions (admin only)
app.get('/api/permissions/roles', authenticateToken, async (req, res) => {
  try {
    // Only admin and GM can access
    if (!['admin', 'general_manager'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }
    const permissions = await db.getAllRolePermissions();
    res.json({ success: true, data: permissions });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Get all permission keys
app.get('/api/permissions/keys', authenticateToken, async (req, res) => {
  try {
    if (!['admin', 'general_manager'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }
    const keys = await db.getAllPermissionKeys();
    res.json({ success: true, data: keys });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Update role permission (admin only)
app.put('/api/permissions/roles/:role/:key', authenticateToken, async (req, res) => {
  try {
    if (!['admin', 'general_manager'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }
    const { allowed } = req.body;
    const result = await db.updateRolePermission(req.params.role, req.params.key, allowed);
    res.json(result);
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Get user permission overrides
app.get('/api/permissions/users/:userId', authenticateToken, async (req, res) => {
  try {
    if (!['admin', 'general_manager'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }
    const overrides = await db.getUserPermissionOverrides(parseInt(req.params.userId));
    res.json({ success: true, data: overrides });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Set user permission override
app.put('/api/permissions/users/:userId/:key', authenticateToken, async (req, res) => {
  try {
    if (!['admin', 'general_manager'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }
    const { allowed } = req.body; // null to remove override
    const result = await db.setUserPermissionOverride(parseInt(req.params.userId), req.params.key, allowed);
    res.json(result);
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============ INVENTORY ROUTES ============

// Get inventory stock levels
app.get('/api/inventory/stock', authenticateToken, async (req, res) => {
  try {
    // Check permission
    const hasPermission = await db.hasPermission(req.user.id, 'inventory.view_stock');
    if (!hasPermission) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }
    const stock = await db.getInventoryStock();
    res.json({ success: true, data: stock });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Get inventory transactions
app.get('/api/inventory/transactions', authenticateToken, async (req, res) => {
  try {
    const filters = {
      transaction_type: req.query.type,
      product_id: req.query.product_id ? parseInt(req.query.product_id) : null,
      store_id: req.query.store_id ? parseInt(req.query.store_id) : null,
      start_date: req.query.start_date,
      end_date: req.query.end_date,
      status: req.query.status,
      limit: req.query.limit ? parseInt(req.query.limit) : null
    };
    const transactions = await db.getInventoryTransactions(filters);
    res.json({ success: true, data: transactions });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Get single inventory transaction
app.get('/api/inventory/transactions/:id', authenticateToken, async (req, res) => {
  try {
    const transaction = await db.getInventoryTransactionById(parseInt(req.params.id));
    if (!transaction) {
      return res.status(404).json({ success: false, error: 'Transaction not found' });
    }
    res.json({ success: true, data: transaction });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Create inventory transaction (in)
app.post('/api/inventory/in', authenticateToken, async (req, res) => {
  try {
    const hasPermission = await db.hasPermission(req.user.id, 'inventory.create_in');
    if (!hasPermission) {
      return res.status(403).json({ success: false, error: 'Access denied - لا تملك صلاحية إنشاء إذن دخول' });
    }
    const data = { ...req.body, transaction_type: 'in' };
    const result = await db.createInventoryTransaction(data, req.user.id);
    res.json(result);
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Create inventory transaction (out)
app.post('/api/inventory/out', authenticateToken, async (req, res) => {
  try {
    const hasPermission = await db.hasPermission(req.user.id, 'inventory.create_out');
    if (!hasPermission) {
      return res.status(403).json({ success: false, error: 'Access denied - لا تملك صلاحية إنشاء إذن خروج' });
    }
    const data = { ...req.body, transaction_type: 'out' };
    const result = await db.createInventoryTransaction(data, req.user.id);
    res.json(result);
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Delete inventory transaction
app.delete('/api/inventory/transactions/:id', authenticateToken, async (req, res) => {
  try {
    const hasPermission = await db.hasPermission(req.user.id, 'inventory.delete');
    if (!hasPermission) {
      return res.status(403).json({ success: false, error: 'Access denied - لا تملك صلاحية حذف المعاملات' });
    }
    const result = await db.deleteInventoryTransaction(parseInt(req.params.id), req.user.id);
    res.json(result);
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Approve inventory transaction
app.put('/api/inventory/transactions/:id/approve', authenticateToken, async (req, res) => {
  try {
    const hasPermission = await db.hasPermission(req.user.id, 'inventory.approve');
    if (!hasPermission) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }
    const result = await db.approveInventoryTransaction(parseInt(req.params.id), req.user.id);
    res.json(result);
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Cancel inventory transaction
app.put('/api/inventory/transactions/:id/cancel', authenticateToken, async (req, res) => {
  try {
    const hasPermission = await db.hasPermission(req.user.id, 'inventory.delete');
    if (!hasPermission) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }
    const result = await db.cancelInventoryTransaction(parseInt(req.params.id), req.user.id);
    res.json(result);
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Get inventory summary report
app.get('/api/inventory/summary', authenticateToken, async (req, res) => {
  try {
    const hasPermission = await db.hasPermission(req.user.id, 'inventory.view_stock');
    if (!hasPermission) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }
    const { start_date, end_date } = req.query;
    const summary = await db.getInventorySummary(start_date, end_date);
    res.json({ success: true, data: summary });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ============ SERVER INFO ============
app.get('/api/server/info', (req, res) => {
  res.json({
    success: true,
    data: {
      version: '2.0.0',
      database: 'PostgreSQL',
      status: 'running'
    }
  });
});

// 404 handler for API
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found' });
});

// Start server
// ============ DIAGNOSTIC ENDPOINT ============
app.get('/api/debug/snapshots-check', authenticateToken, async (req, res) => {
  try {
    // Only allow admin access
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin only' });
    }
    
    // Get total count from stock_snapshot table
    const totalCount = await db.query('SELECT COUNT(*) as count FROM stock_snapshot');
    
    // Get count with JOIN (like getSnapshotsAll does)
    const joinCount = await db.query(`
      SELECT COUNT(*) as count 
      FROM stock_snapshot s
      JOIN products p ON p.id = s.product_id
      JOIN stores st ON st.id = s.store_id
    `);
    
    // Find orphaned snapshots (missing product or store)
    const orphanedProducts = await db.query(`
      SELECT s.id, s.product_id, s.store_id, s.date
      FROM stock_snapshot s
      LEFT JOIN products p ON p.id = s.product_id
      WHERE p.id IS NULL
    `);
    
    const orphanedStores = await db.query(`
      SELECT s.id, s.product_id, s.store_id, s.date
      FROM stock_snapshot s
      LEFT JOIN stores st ON st.id = s.store_id
      WHERE st.id IS NULL
    `);
    
    // Get latest 5 snapshots
    const latestSnapshots = await db.query(`
      SELECT s.id, s.store_id, s.product_id, s.date, st.name as store_name, p.name as product_name
      FROM stock_snapshot s
      LEFT JOIN products p ON p.id = s.product_id
      LEFT JOIN stores st ON st.id = s.store_id
      ORDER BY s.id DESC
      LIMIT 5
    `);
    
    res.json({
      success: true,
      data: {
        total_in_table: parseInt(totalCount[0].count),
        total_with_join: parseInt(joinCount[0].count),
        orphaned_products: orphanedProducts,
        orphaned_stores: orphanedStores,
        latest_snapshots: latestSnapshots
      }
    });
  } catch (error) {
    console.error('[DEBUG] Error:', error);
    res.json({ success: false, error: error.message });
  }
});

async function startServer() {
  try {
    await db.initialize();
    console.log('✅ Database initialized');
    
    // Run maintenance tasks
    try {
      await db.unarchiveActiveTasks();
      await db.archiveOldTasks();
    } catch (e) {
      console.error('Task maintenance error:', e.message);
    }
    
    app.listen(PORT, '0.0.0.0', () => {
      console.log('\n========================================');
      console.log('   🌊 Lagoon Server Started');
      console.log('========================================');
      console.log(`📍 Running on port ${PORT}`);
      console.log(`🗄️  Database: PostgreSQL`);
      console.log('========================================\n');
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
