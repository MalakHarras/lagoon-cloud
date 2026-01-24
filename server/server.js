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
      return res.status(403).json({ success: false, error: 'Invalid token' });
    }
    req.user = user;
    next();
  });
};

// ============ AUTH ROUTES ============
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await db.authenticateUser(username, password);
    
    if (result.success) {
      const token = jwt.sign(
        { id: result.user.id, username: result.user.username, role: result.user.role },
        JWT_SECRET,
        { expiresIn: '24h' }
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
    const result = await db.addUser(req.body, req.user.role);
    res.json({ success: true, data: result });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.put('/api/users/:id', authenticateToken, async (req, res) => {
  try {
    const result = await db.updateUser({ ...req.body, id: parseInt(req.params.id) }, req.user.role);
    res.json({ success: true, data: result });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.delete('/api/users/:id', authenticateToken, async (req, res) => {
  try {
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
    res.json({ success: true, data: snapshots });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/snapshots', authenticateToken, async (req, res) => {
  try {
    const result = await db.addSnapshot(req.body, req.user.id);
    // Mark visit complete if applicable
    if (req.body.store_id && req.body.date) {
      await db.markVisitCompleteFromSnapshot(req.body.store_id, req.user.id, req.body.date);
    }
    res.json({ success: true, data: result });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.delete('/api/snapshots/:id', authenticateToken, async (req, res) => {
  try {
    // Only admin and general_manager can delete snapshots
    if (!['admin', 'general_manager'].includes(req.user.role)) {
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

// ============ TASKS ROUTES ============
app.get('/api/tasks', authenticateToken, async (req, res) => {
  try {
    const tasks = await db.getTasks(req.user.id, req.query);
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
    const schedules = await db.getRouteSchedules(userId);
    res.json({ success: true, data: schedules });
  } catch (error) {
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
    const { startDate, endDate } = req.query;
    const data = await db.getCompetitorsReport(startDate, endDate);
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
    const targetUserId = user_id ? parseInt(user_id) : req.user.userId;
    
    if (isNaN(targetUserId)) {
      return res.json({ success: false, error: 'Invalid user_id' });
    }
    
    const metrics = await db.getTaskMetrics(targetUserId, start_date, end_date);
    res.json({ success: true, data: metrics });
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
