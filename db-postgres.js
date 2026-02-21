// db-postgres.js - PostgreSQL Database Implementation
// Migration from SQLite (sql.js) to PostgreSQL
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

class Database {
  constructor(connectionString) {
    this.connectionString = connectionString || process.env.DATABASE_URL;
    this.pool = null;
    this.initPromise = null; // Track initialization promise to prevent race conditions
  }

  async initialize() {
    // If already initialized, return immediately
    if (this.pool) return;
    
    // If initialization is in progress, wait for it
    if (this.initPromise) {
      return this.initPromise;
    }

    // Start initialization and store the promise
    this.initPromise = this._doInitialize();
    
    try {
      await this.initPromise;
    } catch (error) {
      // Reset on failure so we can retry
      this.initPromise = null;
      throw error;
    }
  }

  async _doInitialize() {
    // Retry connection up to 5 times with exponential backoff
    let retries = 5;
    let lastError;
    
    while (retries > 0) {
      try {
        this.pool = new Pool({
          connectionString: this.connectionString,
          ssl: false,
          max: 20, // Increased for better concurrent request handling
          min: 2, // Keep minimum connections alive
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 15000,
          allowExitOnIdle: false,
        });

        // Test connection with retry
        const client = await this.pool.connect();
        try {
          await client.query('SELECT NOW()');
          console.log('PostgreSQL connected successfully');
        } finally {
          client.release();
        }
        
        // Connection successful, break retry loop
        break;
      } catch (error) {
        lastError = error;
        retries--;
        if (retries > 0) {
          const waitTime = (6 - retries) * 1000; // 1s, 2s, 3s, 4s, 5s
          console.log(`Database connection failed, retrying in ${waitTime}ms... (${retries} attempts left)`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    }
    
    if (retries === 0) {
      console.error('Failed to connect to database after 5 attempts:', lastError);
      throw lastError;
    }

    // Create schema
    await this.createSchema();

    // Check if we need to initialize super admin
    const users = await this.query('SELECT COUNT(*) as count FROM users');
    if (parseInt(users[0].count) === 0) {
      await this.initializeSuperAdmin();
    }
  }

  async createSchema() {
    await this.pool.query(`
      -- Users table
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        full_name VARCHAR(255),
        role VARCHAR(50) NOT NULL CHECK(role IN ('admin', 'general_manager', 'sales_manager', 'accounting_manager', 'import_manager', 'sales_supervisor', 'accountant', 'merchandiser')),
        manager_id INTEGER REFERENCES users(id),
        active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP
      );

      -- Role permissions table - defines what each role can do by default
      CREATE TABLE IF NOT EXISTS role_permissions (
        id SERIAL PRIMARY KEY,
        role VARCHAR(50) NOT NULL,
        permission_key VARCHAR(100) NOT NULL,
        allowed INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(role, permission_key)
      );

      -- User permission overrides - allows per-user customization
      CREATE TABLE IF NOT EXISTS user_permissions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        permission_key VARCHAR(100) NOT NULL,
        allowed INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, permission_key)
      );

      -- Inventory transactions table (دخول/خروج مخزن)
      CREATE TABLE IF NOT EXISTS inventory_transactions (
        id SERIAL PRIMARY KEY,
        transaction_type VARCHAR(10) NOT NULL CHECK(transaction_type IN ('in', 'out')),
        product_id INTEGER NOT NULL REFERENCES products(id),
        quantity DECIMAL(10, 2) NOT NULL,
        unit_cost DECIMAL(10, 2) DEFAULT 0,
        total_cost DECIMAL(12, 2) DEFAULT 0,
        reference_number VARCHAR(100),
        supplier_name VARCHAR(255),
        destination VARCHAR(255),
        store_id INTEGER REFERENCES stores(id),
        note TEXT,
        transaction_date DATE NOT NULL,
        created_by INTEGER NOT NULL REFERENCES users(id),
        approved_by INTEGER REFERENCES users(id),
        approved_at TIMESTAMP,
        status VARCHAR(20) DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'cancelled')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Inventory stock view helper - current stock levels
      CREATE TABLE IF NOT EXISTS inventory_stock (
        id SERIAL PRIMARY KEY,
        product_id INTEGER NOT NULL REFERENCES products(id) UNIQUE,
        current_quantity DECIMAL(10, 2) DEFAULT 0,
        last_in_date DATE,
        last_out_date DATE,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Brands table
      CREATE TABLE IF NOT EXISTS brands (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Products table
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        brand_id INTEGER REFERENCES brands(id),
        unit VARCHAR(50) DEFAULT 'pcs',
        unit_price DECIMAL(10, 2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Store groups table
      CREATE TABLE IF NOT EXISTS store_groups (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        code VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Stores table
      CREATE TABLE IF NOT EXISTS stores (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        code VARCHAR(100),
        store_group_id INTEGER REFERENCES store_groups(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Stock snapshot table
      CREATE TABLE IF NOT EXISTS stock_snapshot (
        id SERIAL PRIMARY KEY,
        store_id INTEGER NOT NULL REFERENCES stores(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        date DATE NOT NULL,
        qty DECIMAL(10, 2) DEFAULT 0,
        expiry_date DATE,
        price DECIMAL(10, 2) DEFAULT 0,
        competitor_prices TEXT,
        note TEXT,
        user_id INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Competitors table
      CREATE TABLE IF NOT EXISTS competitors (
        id SERIAL PRIMARY KEY,
        product_id INTEGER NOT NULL REFERENCES products(id),
        name VARCHAR(255) NOT NULL,
        price DECIMAL(10, 2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Deliveries table
      CREATE TABLE IF NOT EXISTS deliveries (
        id SERIAL PRIMARY KEY,
        store_id INTEGER NOT NULL REFERENCES stores(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        date DATE NOT NULL,
        qty DECIMAL(10, 2) DEFAULT 0,
        note TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Sales Returns table
      CREATE TABLE IF NOT EXISTS sales_returns (
        id SERIAL PRIMARY KEY,
        store_id INTEGER NOT NULL REFERENCES stores(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        date DATE NOT NULL,
        qty DECIMAL(10, 2) DEFAULT 0,
        note TEXT,
        user_id INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Tasks table
      CREATE TABLE IF NOT EXISTS tasks (
        id SERIAL PRIMARY KEY,
        title VARCHAR(500) NOT NULL,
        description TEXT,
        assigned_to INTEGER NOT NULL REFERENCES users(id),
        assigned_by INTEGER NOT NULL REFERENCES users(id),
        priority VARCHAR(20) DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high', 'urgent')),
        status VARCHAR(20) DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'cancelled', 'overdue')),
        due_date DATE,
        due_time TIME,
        start_date DATE,
        completed_at TIMESTAMP,
        is_self_assigned INTEGER DEFAULT 0,
        version INTEGER DEFAULT 1,
        tags TEXT,
        recurrence VARCHAR(20) CHECK(recurrence IS NULL OR recurrence IN ('daily', 'weekly', 'monthly')),
        archived_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Task comments table
      CREATE TABLE IF NOT EXISTS task_comments (
        id SERIAL PRIMARY KEY,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id),
        comment TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Task attachments table
      CREATE TABLE IF NOT EXISTS task_attachments (
        id SERIAL PRIMARY KEY,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id),
        filename VARCHAR(500) NOT NULL,
        filepath VARCHAR(1000) NOT NULL,
        filesize INTEGER,
        mimetype VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Activity logs table
      CREATE TABLE IF NOT EXISTS activity_logs (
        id SERIAL PRIMARY KEY,
        entity_type VARCHAR(50) NOT NULL,
        entity_id INTEGER NOT NULL,
        actor_id INTEGER NOT NULL REFERENCES users(id),
        action VARCHAR(50) NOT NULL,
        field_name VARCHAR(100),
        previous_value TEXT,
        new_value TEXT,
        metadata TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Notifications table
      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        type VARCHAR(50) NOT NULL,
        title VARCHAR(255) NOT NULL,
        message TEXT,
        entity_type VARCHAR(50),
        entity_id INTEGER,
        is_read INTEGER DEFAULT 0,
        idempotency_key VARCHAR(255) UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        read_at TIMESTAMP
      );

      -- KPI daily table
      CREATE TABLE IF NOT EXISTS kpi_daily (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        date DATE NOT NULL,
        tasks_assigned INTEGER DEFAULT 0,
        tasks_completed INTEGER DEFAULT 0,
        tasks_completed_on_time INTEGER DEFAULT 0,
        avg_completion_hours DECIMAL(10, 2) DEFAULT 0,
        overdue_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, date)
      );

      -- Route schedules table
      CREATE TABLE IF NOT EXISTS route_schedules (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        store_id INTEGER NOT NULL REFERENCES stores(id),
        day_of_week INTEGER NOT NULL CHECK(day_of_week >= 0 AND day_of_week <= 6),
        is_recurring INTEGER DEFAULT 1,
        effective_from DATE,
        effective_until DATE,
        created_by INTEGER NOT NULL REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Route tasks table
      CREATE TABLE IF NOT EXISTS route_tasks (
        id SERIAL PRIMARY KEY,
        route_schedule_id INTEGER NOT NULL REFERENCES route_schedules(id) ON DELETE CASCADE,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        scheduled_date DATE NOT NULL,
        store_id INTEGER NOT NULL REFERENCES stores(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        is_completed INTEGER DEFAULT 0,
        completed_by_snapshot_id INTEGER REFERENCES stock_snapshot(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Visit logs table
      CREATE TABLE IF NOT EXISTS visit_logs (
        id SERIAL PRIMARY KEY,
        route_schedule_id INTEGER NOT NULL REFERENCES route_schedules(id) ON DELETE CASCADE,
        store_id INTEGER NOT NULL REFERENCES stores(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        visit_date DATE NOT NULL,
        is_completed INTEGER DEFAULT 0,
        completed_at TIMESTAMP,
        note TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(route_schedule_id, visit_date)
      );

      -- Create indexes
      CREATE INDEX IF NOT EXISTS idx_snapshot_lookup ON stock_snapshot(store_id, product_id, date);
      CREATE INDEX IF NOT EXISTS idx_delivery_lookup ON deliveries(store_id, product_id, date);
      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
      CREATE INDEX IF NOT EXISTS idx_users_manager ON users(manager_id);
      CREATE INDEX IF NOT EXISTS idx_stores_group ON stores(store_group_id);
      CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to);
      CREATE INDEX IF NOT EXISTS idx_tasks_assigned_by ON tasks(assigned_by);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
      CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
      CREATE INDEX IF NOT EXISTS idx_activity_logs_entity ON activity_logs(entity_type, entity_id);
      CREATE INDEX IF NOT EXISTS idx_activity_logs_actor ON activity_logs(actor_id);
      CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
      CREATE INDEX IF NOT EXISTS idx_kpi_daily_user_date ON kpi_daily(user_id, date);
      CREATE INDEX IF NOT EXISTS idx_route_schedules_user ON route_schedules(user_id);
      CREATE INDEX IF NOT EXISTS idx_route_schedules_day ON route_schedules(day_of_week);
      CREATE INDEX IF NOT EXISTS idx_route_tasks_date ON route_tasks(scheduled_date);
      CREATE INDEX IF NOT EXISTS idx_route_tasks_user ON route_tasks(user_id);
      CREATE INDEX IF NOT EXISTS idx_visit_logs_user_date ON visit_logs(user_id, visit_date);
      CREATE INDEX IF NOT EXISTS idx_visit_logs_schedule ON visit_logs(route_schedule_id);
      CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(role);
      CREATE INDEX IF NOT EXISTS idx_user_permissions_user ON user_permissions(user_id);
      CREATE INDEX IF NOT EXISTS idx_inventory_transactions_product ON inventory_transactions(product_id);
      CREATE INDEX IF NOT EXISTS idx_inventory_transactions_date ON inventory_transactions(transaction_date);
      CREATE INDEX IF NOT EXISTS idx_inventory_transactions_type ON inventory_transactions(transaction_type);
      CREATE INDEX IF NOT EXISTS idx_inventory_stock_product ON inventory_stock(product_id);
    `);
    
    // Initialize default role permissions
    await this.initializeDefaultPermissions();
  }

  async initializeDefaultPermissions() {
    // Define all permission keys and their default settings per role
    const permissions = {
      // Page access permissions
      'page.dashboard': { admin: 1, general_manager: 1, sales_manager: 1, accounting_manager: 1, import_manager: 1, sales_supervisor: 1, accountant: 1, merchandiser: 1 },
      'page.tasks': { admin: 1, general_manager: 1, sales_manager: 1, accounting_manager: 1, import_manager: 1, sales_supervisor: 1, accountant: 1, merchandiser: 1 },
      'page.snapshots': { admin: 1, general_manager: 1, sales_manager: 1, accounting_manager: 1, import_manager: 1, sales_supervisor: 1, accountant: 1, merchandiser: 1 },
      'page.deliveries': { admin: 1, general_manager: 1, sales_manager: 1, accounting_manager: 1, import_manager: 1, sales_supervisor: 1, accountant: 1, merchandiser: 1 },
      'page.routes': { admin: 1, general_manager: 1, sales_manager: 1, accounting_manager: 0, import_manager: 0, sales_supervisor: 1, accountant: 0, merchandiser: 1 },
      'page.reports': { admin: 1, general_manager: 1, sales_manager: 1, accounting_manager: 1, import_manager: 1, sales_supervisor: 0, accountant: 0, merchandiser: 0 },
      'page.management': { admin: 1, general_manager: 1, sales_manager: 1, accounting_manager: 0, import_manager: 1, sales_supervisor: 0, accountant: 0, merchandiser: 0 },
      'page.users': { admin: 1, general_manager: 1, sales_manager: 0, accounting_manager: 0, import_manager: 0, sales_supervisor: 0, accountant: 0, merchandiser: 0 },
      'page.access_control': { admin: 1, general_manager: 1, sales_manager: 0, accounting_manager: 0, import_manager: 0, sales_supervisor: 0, accountant: 0, merchandiser: 0 },
      'page.inventory': { admin: 1, general_manager: 1, sales_manager: 1, accounting_manager: 1, import_manager: 1, sales_supervisor: 1, accountant: 1, merchandiser: 0 },
      
      // Inventory permissions
      'inventory.view_stock': { admin: 1, general_manager: 1, sales_manager: 1, accounting_manager: 1, import_manager: 1, sales_supervisor: 0, accountant: 0, merchandiser: 0 },
      'inventory.create_in': { admin: 1, general_manager: 1, sales_manager: 1, accounting_manager: 1, import_manager: 1, sales_supervisor: 1, accountant: 1, merchandiser: 0 },
      'inventory.create_out': { admin: 1, general_manager: 1, sales_manager: 1, accounting_manager: 1, import_manager: 1, sales_supervisor: 1, accountant: 1, merchandiser: 0 },
      'inventory.delete': { admin: 1, general_manager: 1, sales_manager: 0, accounting_manager: 0, import_manager: 0, sales_supervisor: 0, accountant: 0, merchandiser: 0 },
      'inventory.approve': { admin: 1, general_manager: 1, sales_manager: 1, accounting_manager: 1, import_manager: 1, sales_supervisor: 0, accountant: 0, merchandiser: 0 },
      
      // User management permissions
      'users.view': { admin: 1, general_manager: 1, sales_manager: 1, accounting_manager: 1, import_manager: 1, sales_supervisor: 1, accountant: 1, merchandiser: 1 },
      'users.create': { admin: 1, general_manager: 1, sales_manager: 0, accounting_manager: 0, import_manager: 0, sales_supervisor: 0, accountant: 0, merchandiser: 0 },
      'users.edit': { admin: 1, general_manager: 1, sales_manager: 0, accounting_manager: 0, import_manager: 0, sales_supervisor: 0, accountant: 0, merchandiser: 0 },
      'users.delete': { admin: 1, general_manager: 0, sales_manager: 0, accounting_manager: 0, import_manager: 0, sales_supervisor: 0, accountant: 0, merchandiser: 0 },
      
      // Task permissions
      'tasks.view_all': { admin: 1, general_manager: 1, sales_manager: 1, accounting_manager: 1, import_manager: 1, sales_supervisor: 1, accountant: 0, merchandiser: 0 },
      'tasks.assign_to_others': { admin: 1, general_manager: 1, sales_manager: 1, accounting_manager: 1, import_manager: 1, sales_supervisor: 1, accountant: 0, merchandiser: 0 },
      'tasks.delete': { admin: 1, general_manager: 1, sales_manager: 1, accounting_manager: 1, import_manager: 1, sales_supervisor: 0, accountant: 0, merchandiser: 0 },
      
      // Report permissions
      'reports.view_team': { admin: 1, general_manager: 1, sales_manager: 1, accounting_manager: 1, import_manager: 1, sales_supervisor: 1, accountant: 0, merchandiser: 0 },
      'reports.export': { admin: 1, general_manager: 1, sales_manager: 1, accounting_manager: 1, import_manager: 1, sales_supervisor: 0, accountant: 0, merchandiser: 0 },
      
      // Management permissions
      'management.products': { admin: 1, general_manager: 1, sales_manager: 1, accounting_manager: 0, import_manager: 1, sales_supervisor: 0, accountant: 0, merchandiser: 0 },
      'management.stores': { admin: 1, general_manager: 1, sales_manager: 1, accounting_manager: 0, import_manager: 0, sales_supervisor: 0, accountant: 0, merchandiser: 0 },
      'management.brands': { admin: 1, general_manager: 1, sales_manager: 1, accounting_manager: 0, import_manager: 1, sales_supervisor: 0, accountant: 0, merchandiser: 0 },
      
      // Route permissions
      'routes.manage': { admin: 1, general_manager: 1, sales_manager: 1, accounting_manager: 0, import_manager: 0, sales_supervisor: 1, accountant: 0, merchandiser: 0 },
      
      // Snapshot permissions
      'snapshots.edit': { admin: 1, general_manager: 1, sales_manager: 1, accounting_manager: 0, import_manager: 0, sales_supervisor: 1, accountant: 0, merchandiser: 1 },
      'snapshots.delete': { admin: 1, general_manager: 1, sales_manager: 0, accounting_manager: 0, import_manager: 0, sales_supervisor: 0, accountant: 0, merchandiser: 0 },
      
      // Delivery permissions
      'deliveries.create': { admin: 1, general_manager: 1, sales_manager: 1, accounting_manager: 0, import_manager: 1, sales_supervisor: 1, accountant: 0, merchandiser: 1 },
      'deliveries.delete': { admin: 1, general_manager: 1, sales_manager: 0, accounting_manager: 0, import_manager: 0, sales_supervisor: 0, accountant: 0, merchandiser: 0 },
      
      // Returns permissions
      'page.returns': { admin: 1, general_manager: 1, sales_manager: 1, accounting_manager: 1, import_manager: 0, sales_supervisor: 1, accountant: 1, merchandiser: 1 },
      'returns.view': { admin: 1, general_manager: 1, sales_manager: 1, accounting_manager: 1, import_manager: 0, sales_supervisor: 1, accountant: 1, merchandiser: 1 },
      'returns.create': { admin: 1, general_manager: 1, sales_manager: 1, accounting_manager: 0, import_manager: 0, sales_supervisor: 1, accountant: 0, merchandiser: 1 },
      'returns.edit': { admin: 1, general_manager: 1, sales_manager: 0, accounting_manager: 0, import_manager: 0, sales_supervisor: 0, accountant: 0, merchandiser: 0 },
      'returns.delete': { admin: 1, general_manager: 1, sales_manager: 0, accounting_manager: 0, import_manager: 0, sales_supervisor: 0, accountant: 0, merchandiser: 0 },
    };
    
    // Insert default permissions for each role (only if they don't exist)
    for (const [permKey, roleSettings] of Object.entries(permissions)) {
      for (const [role, allowed] of Object.entries(roleSettings)) {
        try {
          await this.execute(
            `INSERT INTO role_permissions (role, permission_key, allowed) 
             VALUES ($1, $2, $3) 
             ON CONFLICT (role, permission_key) DO NOTHING`,
            [role, permKey, allowed]
          );
        } catch (err) {
          // Ignore duplicate key errors
        }
      }
    }
  }

  async initializeSuperAdmin() {
    const hashedPassword = bcrypt.hashSync('06911653@', 10);
    await this.execute(
      'INSERT INTO users (username, password, full_name, role) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
      ['MohamedHarras', hashedPassword, 'Mohamed Harras', 'admin']
    );
  }

  // Note: PostgreSQL doesn't need save() like SQLite - data is persisted automatically
  save() {
    // No-op for PostgreSQL compatibility
  }

  async execute(sql, params = []) {
    await this.initialize(); // Ensure pool is ready
    const pgSql = this.convertToPostgres(sql);
    const client = await this.pool.connect();
    try {
      await client.query(pgSql, params);
    } finally {
      client.release();
    }
  }

  async query(sql, params = []) {
    await this.initialize(); // Ensure pool is ready
    const pgSql = this.convertToPostgres(sql);
    
    // Retry query up to 3 times on connection errors
    let retries = 3;
    let lastError;
    
    while (retries > 0) {
      let client;
      try {
        client = await this.pool.connect();
        const result = await client.query(pgSql, params);
        return result.rows;
      } catch (error) {
        lastError = error;
        // Retry on connection errors, not on SQL errors
        if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === '57P03' || error.code === 'ECONNRESET') {
          retries--;
          if (retries > 0) {
            console.log(`Query failed with connection error ${error.code}, retrying... (${retries} attempts left)`);
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        } else {
          // Non-connection error, throw immediately
          throw error;
        }
      } finally {
        if (client) client.release();
      }
    }
    
    console.error('Query failed after retries:', lastError);
    throw lastError;
  }

  // Convert SQLite-style ? placeholders to PostgreSQL $1, $2, etc.
  convertToPostgres(sql) {
    let counter = 0;
    return sql.replace(/\?/g, () => `$${++counter}`);
  }

  // Get last inserted ID (PostgreSQL uses RETURNING)
  async getLastInsertId(tableName) {
    const result = await this.pool.query(`SELECT currval(pg_get_serial_sequence('${tableName}', 'id')) as id`);
    return result.rows[0]?.id;
  }

  // ========== PRODUCTS ==========
  async getProducts() {
    await this.initialize();
    return this.query(`
      SELECT p.*, b.name as brand_name 
      FROM products p
      LEFT JOIN brands b ON b.id = p.brand_id
      ORDER BY p.name
    `);
  }

  async addProduct(data) {
    await this.initialize();
    const result = await this.pool.query(
      'INSERT INTO products (name, brand_id, unit, unit_price) VALUES ($1, $2, $3, $4) RETURNING id',
      [data.name, data.brand_id || null, data.unit || 'pcs', data.unit_price || 0]
    );
    return { id: result.rows[0].id };
  }

  async updateProduct(data) {
    await this.initialize();
    await this.execute(
      'UPDATE products SET name = $1, brand_id = $2, unit = $3, unit_price = $4 WHERE id = $5',
      [data.name, data.brand_id || null, data.unit, data.unit_price, data.id]
    );
    return { success: true };
  }

  async deleteProduct(id) {
    await this.initialize();
    await this.execute('DELETE FROM competitors WHERE product_id = $1', [id]);
    await this.execute('DELETE FROM products WHERE id = $1', [id]);
    return { success: true };
  }

  // ========== COMPETITORS ==========
  async getCompetitors(productId) {
    await this.initialize();
    return this.query('SELECT * FROM competitors WHERE product_id = $1 ORDER BY name', [productId]);
  }

  async getAllCompetitors() {
    await this.initialize();
    return this.query(`
      SELECT c.*, p.name as product_name 
      FROM competitors c
      JOIN products p ON p.id = c.product_id
      ORDER BY p.name, c.name
    `);
  }

  async addCompetitor(data) {
    await this.initialize();
    const result = await this.pool.query(
      'INSERT INTO competitors (product_id, name, price) VALUES ($1, $2, $3) RETURNING id',
      [data.product_id, data.name, data.price || 0]
    );
    return { id: result.rows[0].id };
  }

  async updateCompetitor(data) {
    await this.initialize();
    await this.execute(
      'UPDATE competitors SET name = $1, price = $2 WHERE id = $3',
      [data.name, data.price, data.id]
    );
    return { success: true };
  }

  async deleteCompetitor(id) {
    await this.initialize();
    await this.execute('DELETE FROM competitors WHERE id = $1', [id]);
    return { success: true };
  }

  // ========== STORES ==========
  async getStores() {
    await this.initialize();
    return this.query(`
      SELECT s.*, g.name as group_name 
      FROM stores s
      LEFT JOIN store_groups g ON g.id = s.store_group_id
      ORDER BY g.name, s.name
    `);
  }

  async getStoreGroups() {
    await this.initialize();
    return this.query('SELECT * FROM store_groups ORDER BY name');
  }

  async addStoreGroup(data) {
    await this.initialize();
    const result = await this.pool.query(
      'INSERT INTO store_groups (name, code) VALUES ($1, $2) RETURNING id',
      [data.name, data.code || '']
    );
    return { id: result.rows[0].id };
  }

  async getOrCreateStoreGroup(name, code = '') {
    await this.initialize();
    const trimmedName = String(name).trim();
    
    const existing = await this.query(
      'SELECT id FROM store_groups WHERE LOWER(name) = LOWER($1)',
      [trimmedName]
    );
    
    if (existing.length > 0) {
      return { id: existing[0].id, created: false };
    }
    
    const result = await this.pool.query(
      'INSERT INTO store_groups (name, code) VALUES ($1, $2) RETURNING id',
      [trimmedName, code]
    );
    
    return { id: result.rows[0].id, created: true };
  }

  async updateStoreGroup(data) {
    await this.initialize();
    await this.execute(
      'UPDATE store_groups SET name = $1, code = $2 WHERE id = $3',
      [data.name, data.code || '', data.id]
    );
    return { success: true };
  }

  async deleteStoreGroup(id) {
    await this.initialize();
    await this.execute('UPDATE stores SET store_group_id = NULL WHERE store_group_id = $1', [id]);
    await this.execute('DELETE FROM store_groups WHERE id = $1', [id]);
    return { success: true };
  }

  // ========== BRANDS ==========
  async getBrands() {
    await this.initialize();
    return this.query('SELECT * FROM brands ORDER BY name');
  }

  async addBrand(data) {
    await this.initialize();
    const result = await this.pool.query(
      'INSERT INTO brands (name) VALUES ($1) RETURNING id',
      [data.name]
    );
    return { id: result.rows[0].id };
  }

  async getOrCreateBrand(name) {
    await this.initialize();
    const trimmedName = String(name).trim();
    
    const existing = await this.query(
      'SELECT id FROM brands WHERE LOWER(name) = LOWER($1)',
      [trimmedName]
    );
    
    if (existing.length > 0) {
      return { id: existing[0].id, created: false };
    }
    
    const result = await this.pool.query(
      'INSERT INTO brands (name) VALUES ($1) RETURNING id',
      [trimmedName]
    );
    
    return { id: result.rows[0].id, created: true };
  }

  async updateBrand(data) {
    await this.initialize();
    await this.execute(
      'UPDATE brands SET name = $1 WHERE id = $2',
      [data.name, data.id]
    );
    return { success: true };
  }

  async deleteBrand(id) {
    await this.initialize();
    await this.execute('UPDATE products SET brand_id = NULL WHERE brand_id = $1', [id]);
    await this.execute('DELETE FROM brands WHERE id = $1', [id]);
    return { success: true };
  }

  async getStoresByGroup(groupId) {
    await this.initialize();
    return this.query('SELECT * FROM stores WHERE store_group_id = $1 ORDER BY name', [groupId]);
  }

  async addStore(data) {
    await this.initialize();
    const result = await this.pool.query(
      'INSERT INTO stores (name, code, store_group_id) VALUES ($1, $2, $3) RETURNING id',
      [data.name, data.code || '', data.store_group_id || null]
    );
    return { id: result.rows[0].id };
  }

  async updateStore(data) {
    await this.initialize();
    await this.execute(
      'UPDATE stores SET name = $1, code = $2, store_group_id = $3 WHERE id = $4',
      [data.name, data.code, data.store_group_id || null, data.id]
    );
    return { success: true };
  }

  async deleteStore(id) {
    await this.initialize();
    await this.execute('DELETE FROM stores WHERE id = $1', [id]);
    return { success: true };
  }

  // ========== SNAPSHOTS ==========
  async addSnapshot(data, userId = null) {
    await this.initialize();
    
    console.log(`[addSnapshot] Called with userId=${userId}, store_id=${data.store_id}, product_id=${data.product_id}, date=${data.date}`);
    
    // Check if snapshot already exists for this store/product/date
    const existing = await this.query(
      'SELECT id FROM stock_snapshot WHERE store_id = $1 AND product_id = $2 AND date = $3',
      [data.store_id, data.product_id, data.date]
    );
    
    let snapshotId = null;
    
    if (existing.length > 0) {
      // Update existing snapshot (overwrite)
      snapshotId = existing[0].id;
      console.log(`[addSnapshot] Updating existing snapshot ID=${snapshotId}`);
      await this.execute(
        `UPDATE stock_snapshot 
         SET qty = $1, expiry_date = $2, price = $3, competitor_prices = $4, note = $5, user_id = $6
         WHERE store_id = $7 AND product_id = $8 AND date = $9`,
        [data.qty || 0, data.expiry_date || null, data.price || 0, data.competitor_prices || null, data.note || null, userId, data.store_id, data.product_id, data.date]
      );
    } else {
      // Insert new snapshot
      console.log(`[addSnapshot] Inserting new snapshot`);
      const result = await this.query(
        'INSERT INTO stock_snapshot (store_id, product_id, date, qty, expiry_date, price, competitor_prices, note, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id',
        [data.store_id, data.product_id, data.date, data.qty || 0, data.expiry_date || null, data.price || 0, data.competitor_prices || null, data.note || null, userId]
      );
      snapshotId = result.length > 0 ? result[0].id : null;
      console.log(`[addSnapshot] New snapshot created with ID=${snapshotId}`);
    }
    
    // After snapshot is created/updated, check if there's a scheduled route and mark related tasks
    if (userId) {
      try {
        console.log(`[addSnapshot] Checking for scheduled routes for userId=${userId}, store_id=${data.store_id}`);
        
        // Find route schedules for this user and store
        const routes = await this.query(
          'SELECT id, user_id FROM route_schedules WHERE user_id = $1 AND store_id = $2',
          [userId, data.store_id]
        );
        
        console.log(`[addSnapshot] Found ${routes.length} route schedules`);
        
        if (routes.length > 0) {
          console.log(`[addSnapshot] Found ${routes.length} scheduled routes for user ${userId}, store ${data.store_id}`);
          
          // Mark visit_logs as completed for route schedules (used by mobile app's /api/route-schedules/my)
          for (const route of routes) {
            console.log(`[addSnapshot] Processing visit_log for route_schedule_id=${route.id}, visit_date=${data.date}`);
            
            // Check if visit_log exists for this route/date
            const existingLog = await this.query(
              'SELECT id, is_completed FROM visit_logs WHERE route_schedule_id = $1 AND visit_date = $2',
              [route.id, data.date]
            );
            
            if (existingLog.length === 0) {
              // Insert new visit_log as completed
              await this.execute(
                `INSERT INTO visit_logs (route_schedule_id, store_id, user_id, visit_date, is_completed, completed_at)
                 VALUES ($1, $2, $3, $4, 1, CURRENT_TIMESTAMP)`,
                [route.id, data.store_id, userId, data.date]
              );
              console.log(`[addSnapshot] Created visit_log for route_schedule_id=${route.id}`);
            } else if (existingLog[0].is_completed !== 1) {
              // Update existing visit_log to completed
              await this.execute(
                'UPDATE visit_logs SET is_completed = 1, completed_at = CURRENT_TIMESTAMP WHERE id = $1',
                [existingLog[0].id]
              );
              console.log(`[addSnapshot] Updated visit_log ID=${existingLog[0].id} to completed`);
            }
          }
          
          // Find any route_tasks related to this route schedule on this date and mark them complete
          for (const route of routes) {
            console.log(`[addSnapshot] Checking route_tasks for route_schedule_id=${route.id}, scheduled_date=${data.date}`);
            
            const routeTasks = await this.query(
              `SELECT id, task_id FROM route_tasks 
               WHERE route_schedule_id = $1 AND scheduled_date = $2 AND user_id = $3`,
              [route.id, data.date, userId]
            );
            
            console.log(`[addSnapshot] Found ${routeTasks.length} route tasks for this visit`);
            
            if (routeTasks.length > 0) {
              console.log(`[addSnapshot] Found ${routeTasks.length} route tasks for this visit, marking as completed`);
              
              for (const routeTask of routeTasks) {
                console.log(`[addSnapshot] Marking route_task ID=${routeTask.id} as completed with snapshot_id=${snapshotId}`);
                
                // Mark the route_task as completed
                await this.execute(
                  'UPDATE route_tasks SET is_completed = $1, completed_by_snapshot_id = $2 WHERE id = $3',
                  [1, snapshotId, routeTask.id]
                );
                
                // Also mark the related task as completed
                if (routeTask.task_id) {
                  console.log(`[addSnapshot] Marking task ID=${routeTask.task_id} as completed`);
                  await this.execute(
                    'UPDATE tasks SET status = $1, completed_at = NOW() WHERE id = $2',
                    ['completed', routeTask.task_id]
                  );
                }
              }
            }
          }
        }
      } catch (err) {
        console.error('[addSnapshot] Error processing route tasks:', err.message);
        // Don't fail snapshot creation if task update fails
      }
    }
    
    return { success: true };
  }

  async getSnapshots(storeId, productId = null, startDate = null, endDate = null) {
    await this.initialize();
    let sql = `
      SELECT s.*, p.name as product_name, p.unit_price as product_price
      FROM stock_snapshot s
      JOIN products p ON p.id = s.product_id
      WHERE s.store_id = $1
    `;
    const params = [storeId];
    let paramIndex = 2;

    if (productId) {
      sql += ` AND s.product_id = $${paramIndex++}`;
      params.push(productId);
    }
    if (startDate) {
      sql += ` AND s.date >= $${paramIndex++}`;
      params.push(startDate);
    }
    if (endDate) {
      sql += ` AND s.date <= $${paramIndex++}`;
      params.push(endDate);
    }

    sql += ' ORDER BY s.date ASC, s.id ASC';
    return this.query(sql, params);
  }

  async deleteSnapshot(id) {
    await this.initialize();
    
    // First, mark any route tasks completed by this snapshot as uncompleted
    await this.execute(
      'UPDATE route_tasks SET is_completed = 0, completed_by_snapshot_id = NULL WHERE completed_by_snapshot_id = $1',
      [id]
    );
    
    // Then delete the snapshot
    await this.execute('DELETE FROM stock_snapshot WHERE id = $1', [id]);
    return { success: true };
  }

  async getSnapshotsAll(storeId = null, productId = null, startDate = null, endDate = null) {
    await this.initialize();
    
    // Use a single client for the entire query to ensure consistency
    const client = await this.pool.connect();
    try {
      let sql = `
        SELECT s.*, p.name as product_name, p.unit_price as product_price, st.name as store_name,
               u.full_name as user_name, u.username as user_username
        FROM stock_snapshot s
        JOIN products p ON p.id = s.product_id
        JOIN stores st ON st.id = s.store_id
        LEFT JOIN users u ON u.id = s.user_id
        WHERE 1=1
      `;
      const params = [];
      let paramIndex = 1;

      if (storeId) {
        sql += ` AND s.store_id = $${paramIndex++}`;
        params.push(storeId);
      }
      if (productId) {
        sql += ` AND s.product_id = $${paramIndex++}`;
        params.push(productId);
      }
      if (startDate) {
        sql += ` AND s.date >= $${paramIndex++}`;
        params.push(startDate);
      }
      if (endDate) {
        sql += ` AND s.date <= $${paramIndex++}`;
        params.push(endDate);
      }

      sql += ' ORDER BY s.date DESC, s.id DESC';
      
      const result = await client.query(sql, params);
      return result.rows || [];
    } finally {
      client.release();
    }
  }

  // ========== DELIVERIES ==========
  async addDelivery(data) {
    await this.initialize();
    await this.execute(
      'INSERT INTO deliveries (store_id, product_id, date, qty, note) VALUES ($1, $2, $3, $4, $5)',
      [data.store_id, data.product_id, data.date, data.qty || 0, data.note || null]
    );
    return { success: true };
  }

  async getDeliveries(storeId, productId = null, startDate = null, endDate = null) {
    await this.initialize();
    let sql = `
      SELECT d.*, p.name as product_name 
      FROM deliveries d
      JOIN products p ON p.id = d.product_id
      WHERE d.store_id = $1
    `;
    const params = [storeId];
    let paramIndex = 2;

    if (productId) {
      sql += ` AND d.product_id = $${paramIndex++}`;
      params.push(productId);
    }
    if (startDate) {
      sql += ` AND d.date >= $${paramIndex++}`;
      params.push(startDate);
    }
    if (endDate) {
      sql += ` AND d.date <= $${paramIndex++}`;
      params.push(endDate);
    }

    sql += ' ORDER BY d.date ASC, d.id ASC';
    return this.query(sql, params);
  }

  async deleteDelivery(id) {
    await this.initialize();
    await this.execute('DELETE FROM deliveries WHERE id = $1', [id]);
    return { success: true };
  }

  async getDeliveriesAll(storeId = null, productId = null, startDate = null, endDate = null) {
    await this.initialize();
    let sql = `
      SELECT d.*, p.name as product_name, st.name as store_name
      FROM deliveries d
      JOIN products p ON p.id = d.product_id
      JOIN stores st ON st.id = d.store_id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (storeId) {
      sql += ` AND d.store_id = $${paramIndex++}`;
      params.push(storeId);
    }
    if (productId) {
      sql += ` AND d.product_id = $${paramIndex++}`;
      params.push(productId);
    }
    if (startDate) {
      sql += ` AND d.date >= $${paramIndex++}`;
      params.push(startDate);
    }
    if (endDate) {
      sql += ` AND d.date <= $${paramIndex++}`;
      params.push(endDate);
    }

    sql += ' ORDER BY d.date DESC, d.id DESC';
    return this.query(sql, params);
  }

  // ========== SALES RETURNS ==========
  async addReturn(data) {
    await this.initialize();
    await this.execute(
      'INSERT INTO sales_returns (store_id, product_id, date, qty, note, user_id) VALUES ($1, $2, $3, $4, $5, $6)',
      [data.store_id, data.product_id, data.date, data.qty || 0, data.note || null, data.user_id || null]
    );
    return { success: true };
  }

  async getReturnsAll(storeId = null, productId = null, startDate = null, endDate = null) {
    await this.initialize();
    let sql = `
      SELECT r.*, p.name as product_name, st.name as store_name, u.full_name as user_name
      FROM sales_returns r
      JOIN products p ON p.id = r.product_id
      JOIN stores st ON st.id = r.store_id
      LEFT JOIN users u ON u.id = r.user_id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (storeId) {
      sql += ` AND r.store_id = $${paramIndex++}`;
      params.push(storeId);
    }
    if (productId) {
      sql += ` AND r.product_id = $${paramIndex++}`;
      params.push(productId);
    }
    if (startDate) {
      sql += ` AND r.date >= $${paramIndex++}`;
      params.push(startDate);
    }
    if (endDate) {
      sql += ` AND r.date <= $${paramIndex++}`;
      params.push(endDate);
    }

    sql += ' ORDER BY r.date DESC, r.id DESC';
    return this.query(sql, params);
  }

  async deleteReturn(id) {
    await this.initialize();
    await this.execute('DELETE FROM sales_returns WHERE id = $1', [id]);
    return { success: true };
  }

  // ========== TURNOVER CALCULATIONS ==========
  async calculateTurnover(storeId, productId, startDate = null, endDate = null) {
    await this.initialize();

    const snapshots = await this.getSnapshots(storeId, productId, startDate, endDate);
    if (snapshots.length < 2) {
      return { success: false, error: 'Need at least 2 snapshots to calculate turnover' };
    }

    const points = [];
    for (let i = 1; i < snapshots.length; i++) {
      const prev = snapshots[i - 1];
      const curr = snapshots[i];

      const deliveries = await this.query(
        `SELECT COALESCE(SUM(qty), 0) as total 
         FROM deliveries 
         WHERE store_id = $1 AND product_id = $2 AND date > $3 AND date <= $4`,
        [storeId, productId, prev.date, curr.date]
      );

      const deliveryQty = Number(deliveries[0]?.total || 0);
      const opening = Number(prev.qty || 0);
      const closing = Number(curr.qty || 0);
      const sold = opening + deliveryQty - closing;

      const d1 = new Date(prev.date + 'T00:00:00Z');
      const d2 = new Date(curr.date + 'T00:00:00Z');
      const days = Math.max(1, Math.round((d2 - d1) / (24 * 60 * 60 * 1000)));

      const monthly = (sold * 30) / days;

      points.push({
        date: curr.date,
        opening,
        deliveries: deliveryQty,
        closing,
        sold,
        days,
        monthly: parseFloat(monthly.toFixed(2))
      });
    }

    return { success: true, points };
  }

  // ========== TASK MANAGEMENT ==========
  canAssignTask(assignerId, assigneeId, assignerRole) {
    if (assignerRole === 'admin' || assignerRole === 'general_manager') {
      return { allowed: true };
    }
    if (assignerId === assigneeId) {
      return { allowed: true };
    }
    // For hierarchical check, we need to query synchronously which is tricky in async
    // This will be handled in the calling code
    return { allowed: true }; // Simplified - actual check done elsewhere
  }

  async getAllSubordinatesFlat(managerId, visited = new Set()) {
    await this.initialize();
    
    if (visited.has(managerId)) return [];
    visited.add(managerId);
    
    const directSubordinates = await this.query(
      'SELECT id, username, full_name, role, manager_id FROM users WHERE manager_id = $1 AND active = 1',
      [managerId]
    );
    
    let allSubordinates = [...directSubordinates];
    
    for (const sub of directSubordinates) {
      const nestedSubs = await this.getAllSubordinatesFlat(sub.id, visited);
      allSubordinates = [...allSubordinates, ...nestedSubs];
    }
    
    return allSubordinates;
  }

  canUpdateTask(userId, userRole, task) {
    if (userRole === 'admin' || userRole === 'general_manager') {
      return { allowed: true };
    }
    if (task.assigned_by === userId) {
      return { allowed: true };
    }
    if (task.assigned_to === userId) {
      return { allowed: true, limitedTo: ['status'] };
    }
    return { 
      allowed: false, 
      code: 'FORBIDDEN',
      message: 'ليس لديك صلاحية لتحديث هذه المهمة'
    };
  }

  async getTasks(userId, filters = {}) {
    await this.initialize();
    
    let sql = `
      SELECT t.*, 
        u1.full_name as assigned_to_name, u1.username as assigned_to_username,
        u2.full_name as assigned_by_name, u2.username as assigned_by_username,
        (SELECT COUNT(*) FROM task_comments WHERE task_id = t.id) as comment_count,
        (SELECT COUNT(*) FROM task_attachments WHERE task_id = t.id) as attachment_count
      FROM tasks t
      JOIN users u1 ON u1.id = t.assigned_to
      JOIN users u2 ON u2.id = t.assigned_by
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (!filters.includeArchived) {
      sql += ' AND t.archived_at IS NULL';
    }

    if (filters.assignedTo) {
      sql += ` AND t.assigned_to = $${paramIndex++}`;
      params.push(filters.assignedTo);
    }

    if (filters.assignedBy) {
      sql += ` AND t.assigned_by = $${paramIndex++}`;
      params.push(filters.assignedBy);
    }

    if (filters.status) {
      if (Array.isArray(filters.status)) {
        sql += ` AND t.status IN (${filters.status.map(() => `$${paramIndex++}`).join(',')})`;
        params.push(...filters.status);
      } else {
        sql += ` AND t.status = $${paramIndex++}`;
        params.push(filters.status);
      }
    }

    if (filters.priority) {
      if (Array.isArray(filters.priority)) {
        sql += ` AND t.priority IN (${filters.priority.map(() => `$${paramIndex++}`).join(',')})`;
        params.push(...filters.priority);
      } else {
        sql += ` AND t.priority = $${paramIndex++}`;
        params.push(filters.priority);
      }
    }

    if (filters.dueDateFrom) {
      sql += ` AND t.due_date >= $${paramIndex++}`;
      params.push(filters.dueDateFrom);
    }

    if (filters.dueDateTo) {
      sql += ` AND t.due_date <= $${paramIndex++}`;
      params.push(filters.dueDateTo);
    }

    if (filters.search) {
      sql += ` AND (t.title ILIKE $${paramIndex} OR t.description ILIKE $${paramIndex})`;
      params.push(`%${filters.search}%`);
      paramIndex++;
    }

    if (filters.tags) {
      sql += ` AND t.tags ILIKE $${paramIndex++}`;
      params.push(`%${filters.tags}%`);
    }

    if (filters.overdueOnly) {
      sql += " AND t.status NOT IN ('completed', 'cancelled') AND t.due_date < CURRENT_DATE";
    }

    await this.updateOverdueTasks();

    sql += " ORDER BY CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, t.due_date ASC, t.created_at DESC";

    if (filters.limit) {
      sql += ` LIMIT $${paramIndex++}`;
      params.push(filters.limit);
      if (filters.offset) {
        sql += ` OFFSET $${paramIndex++}`;
        params.push(filters.offset);
      }
    }

    const tasks = await this.query(sql, params);
    const today = new Date().toISOString().split('T')[0];
    return tasks.map(task => ({
      ...task,
      is_overdue: task.status !== 'completed' && task.status !== 'cancelled' && task.due_date && task.due_date < today
    }));
  }

  async getTaskById(taskId) {
    await this.initialize();
    const tasks = await this.query(`
      SELECT t.*, 
        u1.full_name as assigned_to_name, u1.username as assigned_to_username,
        u2.full_name as assigned_by_name, u2.username as assigned_by_username
      FROM tasks t
      JOIN users u1 ON u1.id = t.assigned_to
      JOIN users u2 ON u2.id = t.assigned_by
      WHERE t.id = $1
    `, [taskId]);
    return tasks[0] || null;
  }

  async getMyTasks(userId, options = {}) {
    return this.getTasks(userId, { 
      assignedTo: userId,
      currentWeekOnly: !options.allTime,
      includeArchived: options.includeArchived
    });
  }

  async getMyTasksAllTime(userId) {
    return this.getTasks(userId, { 
      assignedTo: userId, 
      includeArchived: true 
    });
  }

  async archiveOldTasks() {
    await this.initialize();
    
    const result = await this.pool.query(`
      UPDATE tasks 
      SET archived_at = CURRENT_TIMESTAMP 
      WHERE archived_at IS NULL 
        AND (
          (due_date < CURRENT_DATE - INTERVAL '30 days' AND due_date IS NOT NULL AND status IN ('completed', 'cancelled'))
          OR (status = 'completed' AND completed_at < CURRENT_DATE - INTERVAL '14 days')
        )
    `);
    
    console.log(`Archived ${result.rowCount} old tasks`);
    return { success: true, archivedCount: result.rowCount };
  }

  async unarchiveActiveTasks() {
    await this.initialize();
    
    const result = await this.pool.query(`
      UPDATE tasks 
      SET archived_at = NULL 
      WHERE archived_at IS NOT NULL 
        AND status NOT IN ('completed', 'cancelled')
        AND (due_date IS NULL OR due_date >= CURRENT_DATE - INTERVAL '30 days')
    `);
    
    console.log(`Unarchived ${result.rowCount} active tasks`);
    return { success: true, unarchivedCount: result.rowCount };
  }

  async addTask(data, actorUserId, actorRole) {
    await this.initialize();
    
    if (!data.title || !data.title.trim()) {
      throw { code: 'VALIDATION_ERROR', message: 'عنوان المهمة مطلوب' };
    }
    if (!data.assigned_to) {
      throw { code: 'VALIDATION_ERROR', message: 'يجب تحديد الموظف المعين' };
    }

    const permission = this.canAssignTask(data.assigned_by, data.assigned_to, actorRole);
    if (!permission.allowed) {
      throw { code: permission.code, message: permission.message };
    }
    
    const result = await this.pool.query(
      `INSERT INTO tasks (title, description, assigned_to, assigned_by, priority, due_date, due_time, start_date, is_self_assigned, tags, recurrence, version) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1) RETURNING id`,
      [
        data.title.trim(),
        data.description || '',
        data.assigned_to,
        data.assigned_by,
        data.priority || 'medium',
        data.due_date || null,
        data.due_time || null,
        data.start_date || null,
        data.is_self_assigned ? 1 : 0,
        data.tags || null,
        data.recurrence || null
      ]
    );
    
    const taskId = result.rows[0].id;

    await this.logActivity({
      entity_type: 'task',
      entity_id: taskId,
      actor_id: actorUserId,
      action: 'created',
      new_value: JSON.stringify({ title: data.title, assigned_to: data.assigned_to, priority: data.priority })
    });

    if (data.assigned_to !== data.assigned_by) {
      await this.createNotification({
        user_id: data.assigned_to,
        type: 'task_assigned',
        title: 'مهمة جديدة',
        message: `تم تعيين مهمة جديدة لك: ${data.title}`,
        entity_type: 'task',
        entity_id: taskId,
        idempotency_key: `task_assigned_${taskId}`
      });
    }

    return { id: taskId };
  }

  async updateTask(data, updaterUserId, updaterRole) {
    await this.initialize();
    
    const task = await this.getTaskById(data.id);
    if (!task) {
      throw { code: 'NOT_FOUND', message: 'المهمة غير موجودة' };
    }

    const permission = this.canUpdateTask(updaterUserId, updaterRole, task);
    if (!permission.allowed) {
      throw { code: permission.code, message: permission.message };
    }

    if (data.expectedVersion !== undefined && task.version !== data.expectedVersion) {
      throw { 
        code: 'CONFLICT', 
        message: 'تم تحديث المهمة من قبل مستخدم آخر. يرجى تحديث الصفحة والمحاولة مرة أخرى',
        currentVersion: task.version
      };
    }
    
    const isCreator = task.assigned_by === updaterUserId;
    const isAssignee = task.assigned_to === updaterUserId;
    const isAdmin = updaterRole === 'admin' || updaterRole === 'general_manager';
    
    const changes = {};

    if (isAssignee && !isCreator && !isAdmin) {
      if (data.status && data.status !== task.status) {
        changes.status = { from: task.status, to: data.status };
        await this.execute(
          'UPDATE tasks SET status = $1, updated_at = CURRENT_TIMESTAMP, completed_at = $2, version = version + 1 WHERE id = $3',
          [data.status, data.status === 'completed' ? new Date().toISOString() : null, data.id]
        );
      }
    } else {
      const completedAt = data.status === 'completed' 
        ? (task.status === 'completed' ? task.completed_at : new Date().toISOString())
        : null;

      if (data.title !== undefined && data.title !== task.title) changes.title = { from: task.title, to: data.title };
      if (data.description !== undefined && data.description !== task.description) changes.description = { from: task.description, to: data.description };
      if (data.priority !== undefined && data.priority !== task.priority) changes.priority = { from: task.priority, to: data.priority };
      if (data.status !== undefined && data.status !== task.status) changes.status = { from: task.status, to: data.status };
      if (data.due_date !== undefined && data.due_date !== task.due_date) changes.due_date = { from: task.due_date, to: data.due_date };
      if (data.assigned_to !== undefined && data.assigned_to !== task.assigned_to) {
        changes.assigned_to = { from: task.assigned_to, to: data.assigned_to };
      }

      await this.execute(
        `UPDATE tasks SET title = $1, description = $2, priority = $3, due_date = $4, due_time = $5, 
         status = $6, assigned_to = $7, updated_at = CURRENT_TIMESTAMP, completed_at = $8, version = version + 1 WHERE id = $9`,
        [
          data.title ?? task.title,
          data.description ?? task.description,
          data.priority ?? task.priority,
          data.due_date ?? task.due_date,
          data.due_time ?? task.due_time,
          data.status ?? task.status,
          data.assigned_to ?? task.assigned_to,
          completedAt,
          data.id
        ]
      );
    }

    for (const [field, change] of Object.entries(changes)) {
      await this.logActivity({
        entity_type: 'task',
        entity_id: data.id,
        actor_id: updaterUserId,
        action: 'updated',
        field_name: field,
        previous_value: JSON.stringify(change.from),
        new_value: JSON.stringify(change.to)
      });
    }

    if (changes.status && data.status === 'completed' && task.assigned_by !== updaterUserId) {
      await this.createNotification({
        user_id: task.assigned_by,
        type: 'task_completed',
        title: 'مهمة مكتملة',
        message: `تم إكمال المهمة: ${task.title}`,
        entity_type: 'task',
        entity_id: data.id,
        idempotency_key: `task_completed_${data.id}_${Date.now()}`
      });
    }

    if (changes.assigned_to) {
      await this.createNotification({
        user_id: data.assigned_to,
        type: 'task_assigned',
        title: 'مهمة جديدة',
        message: `تم تعيين مهمة لك: ${task.title}`,
        entity_type: 'task',
        entity_id: data.id,
        idempotency_key: `task_reassigned_${data.id}_${Date.now()}`
      });
    }
    
    const updatedTask = await this.getTaskById(data.id);
    return { success: true, version: updatedTask.version, task: updatedTask };
  }

  async deleteTask(taskId, deleterUserId, deleterRole) {
    await this.initialize();
    
    const task = await this.getTaskById(taskId);
    if (!task) {
      throw { code: 'NOT_FOUND', message: 'المهمة غير موجودة' };
    }
    
    const isAdmin = deleterRole === 'admin' || deleterRole === 'general_manager';
    const isCreator = task.assigned_by === deleterUserId;
    const isSelfAssigned = task.is_self_assigned && task.assigned_to === deleterUserId;

    if (!isAdmin && !isCreator && !isSelfAssigned) {
      throw { code: 'FORBIDDEN', message: 'ليس لديك صلاحية لحذف هذه المهمة' };
    }

    await this.logActivity({
      entity_type: 'task',
      entity_id: taskId,
      actor_id: deleterUserId,
      action: 'deleted',
      previous_value: JSON.stringify({ title: task.title, assigned_to: task.assigned_to, status: task.status })
    });
    
    await this.execute('DELETE FROM task_comments WHERE task_id = $1', [taskId]);
    await this.execute('DELETE FROM task_attachments WHERE task_id = $1', [taskId]);
    await this.execute('DELETE FROM tasks WHERE id = $1', [taskId]);
    return { success: true };
  }

  async addTaskComment(taskId, userId, comment) {
    await this.initialize();
    
    if (!comment || !comment.trim()) {
      throw { code: 'VALIDATION_ERROR', message: 'التعليق مطلوب' };
    }
    
    const task = await this.getTaskById(taskId);
    if (!task) {
      throw { code: 'NOT_FOUND', message: 'المهمة غير موجودة' };
    }
    
    const result = await this.pool.query(
      'INSERT INTO task_comments (task_id, user_id, comment) VALUES ($1, $2, $3) RETURNING id',
      [taskId, userId, comment.trim()]
    );
    
    const commentId = result.rows[0].id;

    await this.logActivity({
      entity_type: 'task',
      entity_id: taskId,
      actor_id: userId,
      action: 'comment_added',
      new_value: JSON.stringify({ comment_id: commentId, preview: comment.substring(0, 100) })
    });

    const notifyUsers = new Set([task.assigned_to, task.assigned_by]);
    notifyUsers.delete(userId);

    for (const notifyUserId of notifyUsers) {
      await this.createNotification({
        user_id: notifyUserId,
        type: 'task_comment',
        title: 'تعليق جديد',
        message: `تعليق جديد على المهمة: ${task.title}`,
        entity_type: 'task',
        entity_id: taskId,
        idempotency_key: `task_comment_${commentId}`
      });
    }

    return { id: commentId };
  }

  async getTaskComments(taskId) {
    await this.initialize();
    
    return this.query(
      `SELECT c.*, u.full_name, u.username 
       FROM task_comments c
       JOIN users u ON u.id = c.user_id
       WHERE c.task_id = $1
       ORDER BY c.created_at ASC`,
      [taskId]
    );
  }

  async getTaskStats(userId, userRole) {
    await this.initialize();
    
    const stats = {
      total: 0,
      pending: 0,
      inProgress: 0,
      completed: 0,
      overdue: 0,
      urgent: 0,
      dueToday: 0,
      dueThisWeek: 0,
      urgentPending: 0
    };

    const today = new Date().toISOString().split('T')[0];
    const weekEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    let sql = 'SELECT status, priority, due_date FROM tasks';
    const params = [];
    
    if (userRole !== 'admin' && userRole !== 'general_manager') {
      sql += ' WHERE assigned_to = $1 OR assigned_by = $1';
      params.push(userId);
    }

    const tasks = await this.query(sql, params);

    for (const task of tasks) {
      stats.total++;
      if (task.status === 'pending') stats.pending++;
      if (task.status === 'in_progress') stats.inProgress++;
      if (task.status === 'completed') stats.completed++;
      if (task.status === 'overdue') stats.overdue++;
      if (task.priority === 'urgent') stats.urgent++;
      if (task.priority === 'urgent' && task.status !== 'completed' && task.status !== 'cancelled') stats.urgentPending++;
      if (task.due_date === today) stats.dueToday++;
      if (task.due_date >= today && task.due_date <= weekEnd) stats.dueThisWeek++;
    }

    return stats;
  }

  async getSubordinates(managerId) {
    await this.initialize();
    return this.query(
      'SELECT id, username, full_name, role FROM users WHERE manager_id = $1 AND active = 1',
      [managerId]
    );
  }

  async getDirectSubordinatesOnly(managerId) {
    await this.initialize();
    
    const directSubordinates = await this.query(
      'SELECT id, username, full_name, role, manager_id FROM users WHERE manager_id = $1 AND active = 1',
      [managerId]
    );
    
    const result = [];
    for (const sub of directSubordinates) {
      const stats = await this.query(`
        SELECT 
          COUNT(*) as total_tasks,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN status NOT IN ('completed', 'cancelled') AND due_date < CURRENT_DATE THEN 1 ELSE 0 END) as overdue
        FROM tasks WHERE assigned_to = $1
      `, [sub.id]);
      
      const hasSubordinatesResult = await this.query(
        'SELECT COUNT(*) as count FROM users WHERE manager_id = $1 AND active = 1',
        [sub.id]
      );
      
      const hasSubordinates = parseInt(hasSubordinatesResult[0].count) > 0;
      
      result.push({
        ...sub,
        task_stats: stats[0] || { total_tasks: 0, pending: 0, in_progress: 0, completed: 0, overdue: 0 },
        has_subordinates: hasSubordinates,
        level: 0
      });
      // NO RECURSION - only direct subordinates
    }
    
    return result;
  }

  async getAllSubordinatesHierarchy(managerId, level = 0, visited = new Set()) {
    await this.initialize();
    
    // Prevent infinite loops
    if (visited.has(managerId)) return [];
    visited.add(managerId);
    
    const directSubordinates = await this.query(
      'SELECT id, username, full_name, role, manager_id FROM users WHERE manager_id = $1 AND active = 1',
      [managerId]
    );
    
    const result = [];
    for (const sub of directSubordinates) {
      const stats = await this.query(`
        SELECT 
          COUNT(*) as total_tasks,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN status NOT IN ('completed', 'cancelled') AND due_date < CURRENT_DATE THEN 1 ELSE 0 END) as overdue
        FROM tasks WHERE assigned_to = $1
      `, [sub.id]);
      
      const hasSubordinatesResult = await this.query(
        'SELECT COUNT(*) as count FROM users WHERE manager_id = $1 AND active = 1',
        [sub.id]
      );
      
      const hasSubordinates = parseInt(hasSubordinatesResult[0].count) > 0;
      
      result.push({
        ...sub,
        task_stats: stats[0] || { total_tasks: 0, pending: 0, in_progress: 0, completed: 0, overdue: 0 },
        has_subordinates: hasSubordinates,
        level: level
      });
      
      // Recursively get all subordinates of this user
      if (hasSubordinates) {
        const subSubordinates = await this.getAllSubordinatesHierarchy(sub.id, level + 1, visited);
        result.push(...subSubordinates);
      }
    }
    
    return result;
  }

  async getTeamMembers(managerId) {
    await this.initialize();
    const subordinates = await this.getSubordinates(managerId);
    
    const result = [];
    for (const sub of subordinates) {
      const stats = await this.query(`
        SELECT 
          COUNT(*) as total_tasks,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN status NOT IN ('completed', 'cancelled') AND due_date < CURRENT_DATE THEN 1 ELSE 0 END) as overdue
        FROM tasks WHERE assigned_to = $1
      `, [sub.id]);

      result.push({
        ...sub,
        task_stats: stats[0] || { total_tasks: 0, pending: 0, in_progress: 0, completed: 0, overdue: 0 }
      });
    }
    
    return result;
  }

  async getTeamMemberTasks(managerId, employeeId, filters = {}) {
    await this.initialize();
    const allSubordinates = await this.getAllSubordinatesFlat(managerId);
    if (!allSubordinates.some(s => s.id === employeeId)) {
      throw { code: 'FORBIDDEN', message: 'هذا الموظف ليس ضمن فريقك' };
    }

    return this.getTasks(managerId, { ...filters, assignedTo: employeeId });
  }

  async updateOverdueTasks() {
    await this.initialize();
    
    const newlyOverdue = await this.query(`
      SELECT id, assigned_to, title FROM tasks 
      WHERE status NOT IN ('completed', 'cancelled', 'overdue') 
        AND due_date < CURRENT_DATE
    `);

    if (newlyOverdue.length > 0) {
      await this.execute(`
        UPDATE tasks 
        SET status = 'overdue', updated_at = CURRENT_TIMESTAMP 
        WHERE status NOT IN ('completed', 'cancelled', 'overdue') 
          AND due_date < CURRENT_DATE
      `);

      const today = new Date().toISOString().split('T')[0];
      for (const task of newlyOverdue) {
        await this.createNotification({
          user_id: task.assigned_to,
          type: 'task_overdue',
          title: 'مهمة متأخرة',
          message: `المهمة "${task.title}" تجاوزت موعد التسليم`,
          entity_type: 'task',
          entity_id: task.id,
          idempotency_key: `task_overdue_${task.id}_${today}`
        });
      }
    }

    return newlyOverdue.length;
  }

  // ========== ACTIVITY LOGS ==========
  async logActivity(log) {
    await this.initialize();
    await this.execute(`
      INSERT INTO activity_logs (entity_type, entity_id, actor_id, action, field_name, previous_value, new_value, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      log.entity_type,
      log.entity_id,
      log.actor_id,
      log.action,
      log.field_name || null,
      log.previous_value || null,
      log.new_value || null,
      log.metadata || null
    ]);
  }

  async getTaskActivity(taskId, limit = 50) {
    await this.initialize();
    return this.query(`
      SELECT a.*, u.full_name, u.username
      FROM activity_logs a
      LEFT JOIN users u ON a.actor_id = u.id
      WHERE a.entity_type = 'task' AND a.entity_id = $1
      ORDER BY a.created_at DESC
      LIMIT $2
    `, [taskId, limit]);
  }

  // ========== NOTIFICATIONS ==========
  async createNotification(notification) {
    await this.initialize();
    
    if (notification.idempotency_key) {
      const existing = await this.query(
        'SELECT id FROM notifications WHERE idempotency_key = $1',
        [notification.idempotency_key]
      );
      if (existing.length > 0) {
        return existing[0].id;
      }
    }

    const result = await this.pool.query(`
      INSERT INTO notifications (user_id, type, title, message, entity_type, entity_id, idempotency_key)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
    `, [
      notification.user_id,
      notification.type,
      notification.title,
      notification.message || null,
      notification.entity_type || null,
      notification.entity_id || null,
      notification.idempotency_key || null
    ]);
    return result.rows[0].id;
  }

  async getNotifications(userId, unreadOnly = false, limit = 50) {
    await this.initialize();
    
    let sql = 'SELECT * FROM notifications WHERE user_id = $1';
    const params = [userId];

    if (unreadOnly) {
      sql += ' AND is_read = 0';
    }

    sql += ' ORDER BY created_at DESC LIMIT $2';
    params.push(limit);

    return this.query(sql, params);
  }

  async getUnreadNotificationCount(userId) {
    await this.initialize();
    const result = await this.query(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = $1 AND is_read = 0',
      [userId]
    );
    return parseInt(result[0]?.count) || 0;
  }

  async markNotificationRead(notificationId, userId) {
    await this.initialize();
    await this.execute(`
      UPDATE notifications 
      SET is_read = 1, read_at = CURRENT_TIMESTAMP 
      WHERE id = $1 AND user_id = $2
    `, [notificationId, userId]);
    return true;
  }

  async markAllNotificationsRead(userId) {
    await this.initialize();
    await this.execute(`
      UPDATE notifications 
      SET is_read = 1, read_at = CURRENT_TIMESTAMP 
      WHERE user_id = $1 AND is_read = 0
    `, [userId]);
    return true;
  }

  // ========== USER MANAGEMENT ==========
  async authenticateUser(username, password) {
    await this.initialize();
    const users = await this.query('SELECT * FROM users WHERE username = $1 AND active = 1', [username]);
    
    if (users.length === 0) {
      return { success: false, error: 'Invalid username or password' };
    }

    const user = users[0];
    const passwordMatch = bcrypt.compareSync(password, user.password);
    
    if (!passwordMatch) {
      return { success: false, error: 'Invalid username or password' };
    }

    await this.execute('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);
    
    const { password: _, ...userWithoutPassword } = user;
    return { success: true, user: userWithoutPassword };
  }

  async getUsers() {
    await this.initialize();
    return this.query(`
      SELECT u.id, u.username, u.full_name, u.role, u.manager_id, u.active, u.created_at, u.last_login,
        m.full_name as manager_name, m.username as manager_username
      FROM users u
      LEFT JOIN users m ON m.id = u.manager_id
      ORDER BY u.username
    `);
  }

  async getManagers() {
    await this.initialize();
    return this.query(
      `SELECT id, username, full_name, role FROM users 
       WHERE role IN ('admin', 'general_manager', 'sales_manager', 'accounting_manager', 'sales_supervisor') AND active = 1
       ORDER BY full_name`
    );
  }

  async getSalesTeam() {
    await this.initialize();
    return this.query(
      `SELECT id, username, full_name, role FROM users 
       WHERE role IN ('merchandiser', 'sales_supervisor') AND active = 1
       ORDER BY full_name`
    );
  }

  async addUser(data, creatorRole) {
    await this.initialize();
    
    if (creatorRole !== 'admin' && creatorRole !== 'general_manager') {
      throw new Error('Only admin can add users');
    }

    const hashedPassword = bcrypt.hashSync(data.password, 10);
    const result = await this.pool.query(
      'INSERT INTO users (username, password, full_name, role, manager_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [data.username, hashedPassword, data.full_name || '', data.role, data.manager_id || null]
    );
    return { id: result.rows[0].id };
  }

  async updateUser(data, updaterRole) {
    await this.initialize();
    
    if (updaterRole !== 'admin' && updaterRole !== 'general_manager') {
      throw new Error('Only admin can update users');
    }

    // Default active to 1 if not specified (preserve user's active status)
    const activeStatus = data.active !== undefined ? data.active : 1;

    if (data.password) {
      const hashedPassword = bcrypt.hashSync(data.password, 10);
      await this.execute(
        'UPDATE users SET username = $1, password = $2, full_name = $3, role = $4, manager_id = $5, active = $6 WHERE id = $7',
        [data.username, hashedPassword, data.full_name, data.role, data.manager_id || null, activeStatus, data.id]
      );
    } else {
      await this.execute(
        'UPDATE users SET username = $1, full_name = $2, role = $3, manager_id = $4, active = $5 WHERE id = $6',
        [data.username, data.full_name, data.role, data.manager_id || null, activeStatus, data.id]
      );
    }
    return { success: true };
  }

  async deleteUser(id, deleterRole) {
    await this.initialize();
    
    if (deleterRole !== 'admin' && deleterRole !== 'general_manager') {
      throw new Error('Only admin can delete users');
    }

    const user = await this.query('SELECT role FROM users WHERE id = $1', [id]);
    if (user.length > 0 && (user[0].role === 'admin' || user[0].role === 'general_manager')) {
      throw new Error('Cannot delete admin or general manager');
    }

    await this.execute('DELETE FROM users WHERE id = $1', [id]);
    return { success: true };
  }

  async changePassword(userId, oldPassword, newPassword) {
    await this.initialize();
    
    const users = await this.query('SELECT password FROM users WHERE id = $1', [userId]);
    if (users.length === 0) {
      throw new Error('User not found');
    }

    const passwordMatch = bcrypt.compareSync(oldPassword, users[0].password);
    if (!passwordMatch) {
      throw new Error('Current password is incorrect');
    }

    const hashedPassword = bcrypt.hashSync(newPassword, 10);
    await this.execute('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, userId]);
    return { success: true };
  }

  // ========== ROUTE SCHEDULES ==========
  async addRouteSchedule(data, createdBy) {
    await this.initialize();
    
    const storeIds = Array.isArray(data.store_ids) ? data.store_ids : [data.store_id];
    const insertedIds = [];
    
    for (const storeId of storeIds) {
      const existing = await this.query(
        'SELECT id FROM route_schedules WHERE user_id = $1 AND store_id = $2 AND day_of_week = $3',
        [data.user_id, storeId, data.day_of_week]
      );
      
      if (existing.length === 0) {
        const result = await this.pool.query(
          `INSERT INTO route_schedules (user_id, store_id, day_of_week, created_by)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [data.user_id, storeId, data.day_of_week, createdBy]
        );
        insertedIds.push(result.rows[0].id);
      }
    }
    
    return { success: true, ids: insertedIds, count: insertedIds.length };
  }

  async updateRouteSchedule(id, data) {
    await this.initialize();
    await this.execute(
      `UPDATE route_schedules SET store_id = $1, day_of_week = $2, is_recurring = $3, effective_from = $4, effective_until = $5, updated_at = CURRENT_TIMESTAMP
       WHERE id = $6`,
      [data.store_id, data.day_of_week, data.is_recurring ?? 1, data.effective_from || null, data.effective_until || null, id]
    );
    return { success: true };
  }

  async deleteRouteSchedule(id) {
    await this.initialize();
    
    try {
      const routeTasks = await this.query('SELECT task_id FROM route_tasks WHERE route_schedule_id = $1', [id]);
      
      for (const rt of routeTasks) {
        await this.execute('DELETE FROM tasks WHERE id = $1', [rt.task_id]);
      }
      
      await this.execute('DELETE FROM route_tasks WHERE route_schedule_id = $1', [id]);
      await this.execute('DELETE FROM route_schedules WHERE id = $1', [id]);
      
      return { success: true, deletedTasks: routeTasks.length };
    } catch (error) {
      console.error('Error deleting route schedule:', error);
      return { success: false, error: error.message };
    }
  }

  async getRouteSchedules(userId = null) {
    await this.initialize();
    
    console.log(`[getRouteSchedules] Called with userId=${userId}`);
    
    // Use local date formatting to avoid timezone issues
    // Format a date as YYYY-MM-DD string (Cairo timezone)
    const formatDateCairo = (d) => {
      const year = d.getUTCFullYear();
      const month = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };
    
    // Get today in Cairo timezone (UTC+2)
    const cairoOffset = 2 * 60 * 60 * 1000;
    const nowUTC = new Date();
    const nowCairo = new Date(nowUTC.getTime() + cairoOffset);
    const todayStr = formatDateCairo(nowCairo);
    console.log(`[getRouteSchedules] Today in Cairo is ${todayStr}, UTC time:`, nowUTC.toISOString());
    
    // Create a 7-day rolling window starting from today (Cairo time)
    const dayDates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(nowCairo);
      d.setUTCDate(nowCairo.getUTCDate() + i);
      dayDates.push({
        date: formatDateCairo(d),
        dayOfWeek: d.getUTCDay()
      });
    }
    console.log(`[getRouteSchedules] 7-day window (Cairo TZ):`, dayDates.map(d => `${d.date}(day${d.dayOfWeek})`).join(', '));
    
    let sql = `
      SELECT rs.*, u.full_name as user_name, u.username, s.name as store_name, s.code as store_code,
             cb.full_name as created_by_name
      FROM route_schedules rs
      JOIN users u ON u.id = rs.user_id
      JOIN stores s ON s.id = rs.store_id
      LEFT JOIN users cb ON cb.id = rs.created_by
    `;
    const params = [];
    
    if (userId) {
      sql += ' WHERE rs.user_id = $1';
      params.push(userId);
    }
    
    sql += ' ORDER BY rs.user_id, rs.day_of_week, s.name';
    console.log(`[getRouteSchedules] SQL:`, sql);
    console.log(`[getRouteSchedules] Params:`, params);
    const schedules = await this.query(sql, params);
    
    console.log(`[getRouteSchedules] Found ${schedules.length} base schedules`);
    if (schedules.length > 0) {
      console.log(`[getRouteSchedules] First schedule:`, {
        id: schedules[0].id,
        user_id: schedules[0].user_id,
        user_name: schedules[0].user_name,
        store_id: schedules[0].store_id,
        store_name: schedules[0].store_name,
        day_of_week: schedules[0].day_of_week
      });
    } else {
      console.log(`[getRouteSchedules] WARNING: No base schedules found in database!`);
    }
    
    if (schedules.length === 0) {
      console.log(`[getRouteSchedules] No schedules found, returning empty array`);
      return [];
    }
    
    // Get all snapshots for scheduled stores on scheduled dates
    const storeIds = schedules.map(s => s.store_id);
    const visitDates = dayDates.map(d => d.date);
    
    console.log(`[getRouteSchedules] storeIds:`, storeIds, 'visitDates:', visitDates);
    
    // Check for snapshots by store_id and date - if a snapshot exists for a store on a date, mark as completed
    const snapshots = await this.query(`
      SELECT DISTINCT store_id, date
      FROM stock_snapshot
      WHERE store_id = ANY($1)
        AND date = ANY($2)
    `, [storeIds, visitDates]);
    
    console.log(`[getRouteSchedules] Found ${snapshots.length} snapshots for scheduled stores/dates`);
    if (snapshots.length > 0) {
      console.log(`[getRouteSchedules] Snapshots:`, snapshots.map(s => ({ 
        store_id: s.store_id, 
        date: s.date,
        dateType: typeof s.date,
        dateConstructor: s.date?.constructor?.name
      })));
    }
    
    // Create lookup map: "storeId_visitDate" -> snapshot exists
    const snapshotMap = {};
    snapshots.forEach((snapshot, idx) => {
      // Convert date to YYYY-MM-DD format properly
      let dateStr;
      if (snapshot.date instanceof Date) {
        // If it's a Date object, format it as YYYY-MM-DD
        const d = snapshot.date;
        dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        console.log(`[getRouteSchedules] Converted Date object to: ${dateStr}`);
      } else {
        // If it's a string, try to extract YYYY-MM-DD using regex
        const dateString = String(snapshot.date);
        const dateMatch = dateString.match(/(\d{4})-(\d{2})-(\d{2})/);
        if (dateMatch) {
          dateStr = dateMatch[0];
          console.log(`[getRouteSchedules] Extracted date from '${dateString}': ${dateStr}`);
        } else {
          // Try ISO format fallback
          dateStr = dateString.substring(0, 10);
          console.log(`[getRouteSchedules] Could not extract with regex, used substring: ${dateStr}`);
        }
      }
      
      const key = `${snapshot.store_id}_${dateStr}`;
      snapshotMap[key] = true;
      console.log(`[getRouteSchedules] snapshotMap[${key}] = true`);
    });
    
    console.log(`[getRouteSchedules] Final snapshotMap keys:`, Object.keys(snapshotMap));
    
    // Build result with rolling 7-day window
    const result = [];
    for (const dayInfo of dayDates) {
      const matchingSchedules = schedules.filter(s => s.day_of_week === dayInfo.dayOfWeek);
      console.log(`[getRouteSchedules] Day ${dayInfo.date} (dayOfWeek=${dayInfo.dayOfWeek}): Found ${matchingSchedules.length} matching schedules`);
      
      for (const schedule of matchingSchedules) {
        const key = `${schedule.store_id}_${dayInfo.date}`;
        const hasSnapshot = snapshotMap[key] || false;
        
        console.log(`[getRouteSchedules] Building result: store_id=${schedule.store_id}, visit_date=${dayInfo.date}, key=${key}, hasSnapshot=${hasSnapshot}, snapshotMapKeys=${Object.keys(snapshotMap)}`);
        
        result.push({
          ...schedule,
          is_completed: hasSnapshot ? 1 : 0,
          visit_date: dayInfo.date
        });
      }
    }
    
    // Sort by visit_date to ensure chronological order (today first)
    // visit_date is a string in YYYY-MM-DD format
    result.sort((a, b) => {
      const dateA = String(a.visit_date);
      const dateB = String(b.visit_date);
      return dateA.localeCompare(dateB);
    });
    
    console.log(`[getRouteSchedules] Returning ${result.length} schedule entries (${schedules.length} base schedules × 7 days)`);
    if (result.length > 0) {
      console.log(`[getRouteSchedules] First result:`, {
        store_name: result[0].store_name,
        visit_date: result[0].visit_date,
        is_completed: result[0].is_completed
      });
    }
    
    return result;
  }

  async getRouteSchedulesByDay(dayOfWeek, userId = null) {
    await this.initialize();
    let sql = `
      SELECT rs.*, u.full_name as user_name, u.username, s.name as store_name, s.code as store_code
      FROM route_schedules rs
      JOIN users u ON u.id = rs.user_id
      JOIN stores s ON s.id = rs.store_id
      WHERE rs.day_of_week = $1
    `;
    const params = [dayOfWeek];
    
    if (userId) {
      sql += ' AND rs.user_id = $2';
      params.push(userId);
    }
    
    sql += ' ORDER BY s.name';
    return this.query(sql, params);
  }

  async getUserWeeklySchedule(userId) {
    await this.initialize();
    return this.query(`
      SELECT rs.*, s.name as store_name, s.code as store_code
      FROM route_schedules rs
      JOIN stores s ON s.id = rs.store_id
      WHERE rs.user_id = $1
      ORDER BY rs.day_of_week, s.name
    `, [userId]);
  }

  async getUserWeeklyScheduleWithVisits(userId) {
    await this.initialize();
    
    // Use Cairo timezone (UTC+2)
    const formatDateCairo = (d) => {
      const year = d.getUTCFullYear();
      const month = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };
    
    // Get today in Cairo timezone
    const cairoOffset = 2 * 60 * 60 * 1000;
    const nowUTC = new Date();
    const nowCairo = new Date(nowUTC.getTime() + cairoOffset);
    
    // Create a 7-day rolling window starting from today (Cairo time)
    const dayDates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(nowCairo);
      d.setUTCDate(nowCairo.getUTCDate() + i);
      dayDates.push({
        date: formatDateCairo(d),
        dayOfWeek: d.getUTCDay()
      });
    }
    
    // Get all schedules for user with store info
    const schedules = await this.query(`
      SELECT rs.*, s.name as store_name, s.code as store_code
      FROM route_schedules rs
      JOIN stores s ON s.id = rs.store_id
      WHERE rs.user_id = $1
      ORDER BY rs.day_of_week, s.name
    `, [userId]);
    
    if (schedules.length === 0) {
      return [];
    }
    
    // Get all visit logs for this user for the next 7 days in ONE query
    const visitDates = dayDates.map(d => d.date);
    const scheduleIds = schedules.map(s => s.id);
    
    const visitLogs = await this.query(`
      SELECT route_schedule_id, visit_date, id, is_completed, completed_at 
      FROM visit_logs 
      WHERE route_schedule_id = ANY($1) 
        AND visit_date = ANY($2)
    `, [scheduleIds, visitDates]);
    
    // Create a lookup map for O(1) access: "scheduleId_date" -> visit log
    const visitLogMap = {};
    visitLogs.forEach(vl => {
      // Convert visit_date to YYYY-MM-DD format properly
      let dateStr;
      if (vl.visit_date instanceof Date) {
        const d = vl.visit_date;
        dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      } else {
        const dateString = String(vl.visit_date);
        const dateMatch = dateString.match(/(\d{4})-(\d{2})-(\d{2})/);
        dateStr = dateMatch ? dateMatch[0] : dateString.substring(0, 10);
      }
      const key = `${vl.route_schedule_id}_${dateStr}`;
      visitLogMap[key] = vl;
    });
    
    const result = [];
    // For each day in the next 7 days
    for (const dayInfo of dayDates) {
      // Find schedules that match this day of week
      const matchingSchedules = schedules.filter(s => s.day_of_week === dayInfo.dayOfWeek);
      
      for (const schedule of matchingSchedules) {
        const key = `${schedule.id}_${dayInfo.date}`;
        const visitLog = visitLogMap[key];
        
        result.push({
          ...schedule,
          visit_log_id: visitLog?.id || null,
          is_completed: visitLog?.is_completed || 0,
          visit_date: dayInfo.date,
          completed_at: visitLog?.completed_at || null
        });
      }
    }
    
    // Sort by visit_date to ensure chronological order (today first)
    // visit_date is a string in YYYY-MM-DD format
    result.sort((a, b) => {
      const dateA = String(a.visit_date);
      const dateB = String(b.visit_date);
      return dateA.localeCompare(dateB);
    });
    
    return result;
  }

  async toggleVisitComplete(routeScheduleId, visitDate, userId) {
    await this.initialize();
    
    const schedule = await this.query('SELECT * FROM route_schedules WHERE id = $1', [routeScheduleId]);
    if (schedule.length === 0) {
      return { success: false, error: 'Route schedule not found' };
    }
    
    const existing = await this.query(
      'SELECT * FROM visit_logs WHERE route_schedule_id = $1 AND visit_date = $2',
      [routeScheduleId, visitDate]
    );
    
    if (existing.length === 0) {
      await this.execute(
        `INSERT INTO visit_logs (route_schedule_id, store_id, user_id, visit_date, is_completed, completed_at)
         VALUES ($1, $2, $3, $4, 1, CURRENT_TIMESTAMP)`,
        [routeScheduleId, schedule[0].store_id, userId, visitDate]
      );
      return { success: true, isCompleted: true };
    } else {
      const newStatus = existing[0].is_completed ? 0 : 1;
      await this.execute(
        `UPDATE visit_logs SET is_completed = $1, completed_at = $2 WHERE id = $3`,
        [newStatus, newStatus ? new Date().toISOString() : null, existing[0].id]
      );
      return { success: true, isCompleted: newStatus === 1 };
    }
  }

  async markVisitCompleteFromSnapshot(storeId, userId, visitDate) {
    await this.initialize();
    
    // Parse the date correctly - visitDate is in YYYY-MM-DD format
    // Calculate day of week using Cairo timezone (UTC+2)
    const cairoOffset = 2 * 60 * 60 * 1000; // UTC+2
    const dateObj = new Date(visitDate + 'T12:00:00Z');
    const dateInCairo = new Date(dateObj.getTime() + cairoOffset);
    const dayOfWeek = dateInCairo.getUTCDay();
    
    console.log(`[Route Mark] Looking for schedule: userId=${userId}, storeId=${storeId}, visitDate=${visitDate}, dayOfWeek=${dayOfWeek}`);
    
    const schedule = await this.query(
      'SELECT id, store_id FROM route_schedules WHERE user_id = $1 AND store_id = $2 AND day_of_week = $3',
      [userId, storeId, dayOfWeek]
    );
    
    console.log(`[Route Mark] Found ${schedule.length} matching schedules`);
    
    if (schedule.length === 0) {
      return { success: true, noSchedule: true };
    }
    
    const routeScheduleId = schedule[0].id;
    
    // Delete any existing visit log for this schedule and date
    await this.execute(
      'DELETE FROM visit_logs WHERE route_schedule_id = $1 AND visit_date = $2',
      [routeScheduleId, visitDate]
    );
    
    // Insert new completed visit log
    await this.execute(
      `INSERT INTO visit_logs (route_schedule_id, store_id, user_id, visit_date, is_completed, completed_at)
       VALUES ($1, $2, $3, $4, 1, CURRENT_TIMESTAMP)`,
      [routeScheduleId, storeId, userId, visitDate]
    );
    
    console.log(`[Route Mark] Visit marked as completed for route ${routeScheduleId}, date ${visitDate}`);
    
    return { success: true, isCompleted: true };
  }

  async getMonthlyVisitCount(userId) {
    await this.initialize();
    
    // Use Cairo timezone for date calculations
    const cairoOffset = 2 * 60 * 60 * 1000; // UTC+2
    const nowUTC = new Date();
    const nowCairo = new Date(nowUTC.getTime() + cairoOffset);
    
    // Get first day of current month in Cairo timezone
    const monthStartCairo = new Date(nowCairo);
    monthStartCairo.setUTCDate(1);
    monthStartCairo.setUTCHours(0, 0, 0, 0);
    const monthStart = monthStartCairo.toISOString().split('T')[0];
    
    // Get today in Cairo timezone
    const monthEnd = nowCairo.toISOString().split('T')[0];
    
    console.log(`[getMonthlyVisitCount] User ${userId}: Month range ${monthStart} to ${monthEnd}`);
    
    // Count snapshots only for stores that are scheduled for this user
    const result = await this.query(`
      SELECT COUNT(DISTINCT ss.store_id || '_' || ss.date) as count
      FROM stock_snapshot ss
      INNER JOIN route_schedules rs ON ss.store_id = rs.store_id
      WHERE rs.user_id = $1 AND ss.date >= $2 AND ss.date <= $3 AND ss.user_id = $1
    `, [userId, monthStart, monthEnd]);
    
    const count = parseInt(result[0]?.count) || 0;
    console.log(`[getMonthlyVisitCount] User ${userId}: ${count} completed visits this month`);
    
    return count;
  }

  async getMonthlyVisitCountForUsers(userIds) {
    await this.initialize();
    
    if (!userIds || userIds.length === 0) return {};
    
    // Use Cairo timezone for date calculations
    const cairoOffset = 2 * 60 * 60 * 1000; // UTC+2
    const nowUTC = new Date();
    const nowCairo = new Date(nowUTC.getTime() + cairoOffset);
    
    // Get first day of current month in Cairo timezone
    const monthStartCairo = new Date(nowCairo);
    monthStartCairo.setUTCDate(1);
    monthStartCairo.setUTCHours(0, 0, 0, 0);
    const monthStart = monthStartCairo.toISOString().split('T')[0];
    
    // Get today in Cairo timezone
    const monthEnd = nowCairo.toISOString().split('T')[0];
    
    const placeholders = userIds.map((_, i) => `$${i + 1}`).join(',');
    const results = await this.query(`
      SELECT user_id, COUNT(*) as count
      FROM visit_logs
      WHERE user_id IN (${placeholders}) AND is_completed = 1 AND visit_date >= $${userIds.length + 1} AND visit_date <= $${userIds.length + 2}
      GROUP BY user_id
    `, [...userIds, monthStart, monthEnd]);
    
    const counts = {};
    for (const row of results) {
      counts[row.user_id] = parseInt(row.count);
    }
    return counts;
  }

  async getTeamRoutes(managerId, role) {
    await this.initialize();
    let userFilter = '';
    const params = [];
    
    if (role === 'sales_supervisor') {
      userFilter = 'WHERE u.manager_id = $1';
      params.push(managerId);
    } else if (role === 'sales_manager') {
      userFilter = "WHERE u.role IN ('sales_supervisor', 'merchandiser')";
    }
    
    return this.query(`
      SELECT rs.*, u.full_name as user_name, u.username, u.role as user_role,
             s.name as store_name, s.code as store_code
      FROM route_schedules rs
      JOIN users u ON u.id = rs.user_id
      JOIN stores s ON s.id = rs.store_id
      ${userFilter}
      ORDER BY u.full_name, rs.day_of_week, s.name
    `, params);
  }

  // ========== REPORTS ==========
  async getSnapshotsMatrixReport(startDate, endDate) {
    await this.initialize();
    
    return this.query(`
      SELECT 
        s.store_id,
        st.name as store_name,
        st.code as store_code,
        s.user_id,
        u.full_name as employee_name,
        u.username,
        COUNT(DISTINCT s.date) as visit_count
      FROM stock_snapshot s
      JOIN stores st ON st.id = s.store_id
      LEFT JOIN users u ON u.id = s.user_id
      WHERE s.date >= $1 AND s.date <= $2 AND s.user_id IS NOT NULL
      GROUP BY s.store_id, st.name, st.code, s.user_id, u.full_name, u.username
      ORDER BY st.name, u.full_name
    `, [startDate, endDate]);
  }

  async getDeliveriesMatrixReport(startDate, endDate, storeId = null) {
    await this.initialize();
    
    let sql = `
      SELECT 
        d.store_id,
        st.name as store_name,
        st.code as store_code,
        d.product_id,
        p.name as product_name,
        SUM(d.qty) as total_qty
      FROM deliveries d
      JOIN stores st ON st.id = d.store_id
      JOIN products p ON p.id = d.product_id
      WHERE d.date >= $1 AND d.date <= $2
    `;
    const params = [startDate, endDate];
    
    if (storeId) {
      sql += ' AND d.store_id = $3';
      params.push(storeId);
    }
    
    sql += ' GROUP BY d.store_id, st.name, st.code, d.product_id, p.name ORDER BY st.name, p.name';
    
    return this.query(sql, params);
  }

  async getCompetitorsReport(startDate, endDate, storeGroupId = null) {
    await this.initialize();
    
    try {
      const allProducts = await this.query('SELECT id, name FROM products ORDER BY name') || [];
      const allCompetitors = await this.query('SELECT id, product_id, name FROM competitors ORDER BY name') || [];
      
      let snapshotSql = `
        SELECT 
          s.product_id,
          s.store_id,
          s.price,
          s.competitor_prices,
          s.date
        FROM stock_snapshot s
        JOIN stores st ON st.id = s.store_id
        WHERE s.date >= $1 AND s.date <= $2
          AND (s.price > 0 OR s.competitor_prices IS NOT NULL)
      `;
      
      const params = [startDate, endDate];
      
      if (storeGroupId) {
        snapshotSql += ' AND st.store_group_id = $3';
        params.push(storeGroupId);
      }
      
      snapshotSql += ' ORDER BY s.date DESC';
      
      const snapshots = await this.query(snapshotSql, params) || [];
      
      return {
        products: allProducts,
        competitors: allCompetitors,
        snapshots
      };
    } catch (error) {
      console.error('getCompetitorsReport error:', error);
      throw error;
    }
  }

  // ========== KPI METHODS ==========
  async getUserKPIStats(userId, startDate, endDate) {
    await this.initialize();
    
    try {
      // Get task statistics for the user
      const taskStats = await this.query(`
        SELECT 
          COUNT(*) as total_tasks,
          COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_tasks,
          COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_tasks,
          COUNT(CASE WHEN status = 'in_progress' THEN 1 END) as in_progress_tasks,
          COUNT(CASE WHEN status = 'overdue' OR (status != 'completed' AND due_date < CURRENT_DATE) THEN 1 END) as overdue_tasks,
          COUNT(CASE WHEN status = 'completed' AND completed_at IS NOT NULL AND due_date IS NOT NULL 
            AND DATE(completed_at) <= DATE(due_date) THEN 1 END) as completed_on_time,
          COUNT(CASE WHEN status = 'completed' AND completed_at IS NOT NULL AND due_date IS NOT NULL 
            AND DATE(completed_at) > DATE(due_date) THEN 1 END) as completed_late
        FROM tasks 
        WHERE assigned_to = $1
          AND ($2::date IS NULL OR created_at >= $2::date)
          AND ($3::date IS NULL OR created_at <= $3::date)
      `, [userId, startDate || null, endDate || null]);

      // Get visit statistics
      const visitStats = await this.query(`
        SELECT 
          COUNT(*) as total_visits,
          COUNT(CASE WHEN is_completed = 1 THEN 1 END) as completed_visits
        FROM visit_logs
        WHERE user_id = $1
          AND ($2::date IS NULL OR visit_date >= $2::date)
          AND ($3::date IS NULL OR visit_date <= $3::date)
      `, [userId, startDate || null, endDate || null]);

      // Get snapshot count
      const snapshotStats = await this.query(`
        SELECT COUNT(*) as total_snapshots
        FROM stock_snapshot
        WHERE user_id = $1
          AND ($2::date IS NULL OR date >= $2::date)
          AND ($3::date IS NULL OR date <= $3::date)
      `, [userId, startDate || null, endDate || null]);

      return {
        tasks: taskStats[0] || { total_tasks: 0, completed_tasks: 0, pending_tasks: 0, in_progress_tasks: 0, overdue_tasks: 0, completed_on_time: 0, completed_late: 0 },
        visits: visitStats[0] || { total_visits: 0, completed_visits: 0 },
        snapshots: parseInt(snapshotStats[0]?.total_snapshots || 0)
      };
    } catch (error) {
      console.error('getUserKPIStats error:', error);
      return {
        tasks: { total_tasks: 0, completed_tasks: 0, pending_tasks: 0, in_progress_tasks: 0, overdue_tasks: 0, completed_on_time: 0, completed_late: 0 },
        visits: { total_visits: 0, completed_visits: 0 },
        snapshots: 0
      };
    }
  }

  async getTaskMetrics(userId, startDate, endDate) {
    await this.initialize();
    
    try {
      const metrics = await this.query(`
        SELECT 
          COUNT(*) as total_assigned,
          COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
          COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
          COUNT(CASE WHEN status = 'in_progress' THEN 1 END) as in_progress,
          COUNT(CASE WHEN status = 'completed' AND completed_at IS NOT NULL AND due_date IS NOT NULL 
            AND DATE(completed_at) <= DATE(due_date) THEN 1 END) as completed_on_time,
          AVG(CASE WHEN status = 'completed' AND completed_at IS NOT NULL 
            THEN EXTRACT(EPOCH FROM (completed_at - created_at)) / 3600 
          END) as avg_completion_hours,
          COUNT(CASE WHEN status != 'completed' AND due_date < CURRENT_DATE THEN 1 END) as overdue
        FROM tasks
        WHERE assigned_to = $1
          AND archived_at IS NULL
          AND ($2::date IS NULL OR created_at >= $2::date)
          AND ($3::date IS NULL OR created_at <= $3::date)
      `, [userId, startDate || null, endDate || null]);

      const stats = metrics[0] || {};
      
      // Get weekly trend
      const weeklyTrend = await this.query(`
        SELECT 
          TO_CHAR(DATE_TRUNC('week', created_at), 'IYYY-IW') as week,
          COUNT(*) as total,
          COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed
        FROM tasks
        WHERE assigned_to = $1
          AND archived_at IS NULL
          AND ($2::date IS NULL OR created_at >= $2::date)
          AND ($3::date IS NULL OR created_at <= $3::date)
        GROUP BY week
        ORDER BY week DESC
        LIMIT 8
      `, [userId, startDate || null, endDate || null]);
      
      return {
        total_assigned: parseInt(stats.total_assigned || 0),
        completed: parseInt(stats.completed || 0),
        pending: parseInt(stats.pending || 0),
        in_progress: parseInt(stats.in_progress || 0),
        completed_on_time: parseInt(stats.completed_on_time || 0),
        avg_completion_hours: parseFloat(stats.avg_completion_hours || 0).toFixed(1),
        overdue: parseInt(stats.overdue || 0),
        completion_rate: stats.total_assigned > 0 ? 
          ((parseInt(stats.completed || 0) / parseInt(stats.total_assigned)) * 100).toFixed(1) : 0,
        on_time_rate: stats.completed > 0 ?
          ((parseInt(stats.completed_on_time || 0) / parseInt(stats.completed)) * 100).toFixed(1) : 0,
        weekly_trend: weeklyTrend || []
      };
    } catch (error) {
      console.error('getTaskMetrics error:', error);
      return {
        total_assigned: 0,
        completed: 0,
        pending: 0,
        in_progress: 0,
        completed_on_time: 0,
        avg_completion_hours: 0,
        overdue: 0,
        completion_rate: 0,
        on_time_rate: 0,
        weekly_trend: []
      };
    }
  }

  // ========== REPORTS - Visits and Deliveries ==========
  async getVisitsReport(startDate, endDate) {
    await this.initialize();
    
    try {
      const result = await this.query(`
        SELECT 
          vl.user_id,
          u.full_name as employee_name,
          u.username,
          u.role,
          COUNT(*) as total_visits,
          COUNT(CASE WHEN vl.is_completed = 1 THEN 1 END) as completed_visits
        FROM visit_logs vl
        JOIN users u ON u.id = vl.user_id
        WHERE vl.visit_date >= $1 AND vl.visit_date <= $2
        GROUP BY vl.user_id, u.full_name, u.username, u.role
        ORDER BY u.full_name
      `, [startDate, endDate]);
      
      return result;
    } catch (error) {
      console.error('getVisitsReport error:', error);
      return [];
    }
  }

  async getDeliveriesReport(startDate, endDate) {
    await this.initialize();
    
    try {
      // Get deliveries with user info from snapshots (since snapshots are created by users)
      const result = await this.query(`
        SELECT 
          d.store_id,
          st.name as store_name,
          COUNT(*) as delivery_count,
          SUM(d.qty) as total_qty
        FROM deliveries d
        JOIN stores st ON st.id = d.store_id
        WHERE d.date >= $1 AND d.date <= $2
        GROUP BY d.store_id, st.name
        ORDER BY st.name
      `, [startDate, endDate]);
      
      return result;
    } catch (error) {
      console.error('getDeliveriesReport error:', error);
      return [];
    }
  }

  // ========== PERMISSION MANAGEMENT ==========
  
  // Get all permissions for a specific user (combines role defaults with user overrides)
  async getUserPermissions(userId) {
    await this.initialize();
    
    // Get user's role
    const userResult = await this.query('SELECT role FROM users WHERE id = $1', [userId]);
    if (userResult.length === 0) {
      return {};
    }
    const userRole = userResult[0].role;
    
    // Get role default permissions
    const rolePerms = await this.query(
      'SELECT permission_key, allowed FROM role_permissions WHERE role = $1',
      [userRole]
    );
    
    // Get user-specific overrides
    const userPerms = await this.query(
      'SELECT permission_key, allowed FROM user_permissions WHERE user_id = $1',
      [userId]
    );
    
    // Merge: start with role defaults, then apply user overrides
    const permissions = {};
    rolePerms.forEach(p => {
      permissions[p.permission_key] = p.allowed === 1;
    });
    userPerms.forEach(p => {
      permissions[p.permission_key] = p.allowed === 1;
    });
    
    return permissions;
  }
  
  // Check if user has a specific permission
  async hasPermission(userId, permissionKey) {
    const permissions = await this.getUserPermissions(userId);
    return permissions[permissionKey] === true;
  }
  
  // Get all role permissions (for admin view)
  async getAllRolePermissions() {
    await this.initialize();
    const result = await this.query(
      'SELECT role, permission_key, allowed FROM role_permissions ORDER BY role, permission_key'
    );
    
    // Group by role
    const grouped = {};
    result.forEach(r => {
      if (!grouped[r.role]) grouped[r.role] = {};
      grouped[r.role][r.permission_key] = r.allowed === 1;
    });
    return grouped;
  }
  
  // Update a role's permission
  async updateRolePermission(role, permissionKey, allowed) {
    await this.initialize();
    await this.execute(
      `INSERT INTO role_permissions (role, permission_key, allowed) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (role, permission_key) 
       DO UPDATE SET allowed = $3`,
      [role, permissionKey, allowed ? 1 : 0]
    );
    return { success: true };
  }
  
  // Get user-specific permission overrides
  async getUserPermissionOverrides(userId) {
    await this.initialize();
    const result = await this.query(
      'SELECT permission_key, allowed FROM user_permissions WHERE user_id = $1',
      [userId]
    );
    const overrides = {};
    result.forEach(r => {
      overrides[r.permission_key] = r.allowed === 1;
    });
    return overrides;
  }
  
  // Set user-specific permission override
  async setUserPermissionOverride(userId, permissionKey, allowed) {
    await this.initialize();
    if (allowed === null) {
      // Remove override (use role default)
      await this.execute(
        'DELETE FROM user_permissions WHERE user_id = $1 AND permission_key = $2',
        [userId, permissionKey]
      );
    } else {
      await this.execute(
        `INSERT INTO user_permissions (user_id, permission_key, allowed, updated_at) 
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP) 
         ON CONFLICT (user_id, permission_key) 
         DO UPDATE SET allowed = $3, updated_at = CURRENT_TIMESTAMP`,
        [userId, permissionKey, allowed ? 1 : 0]
      );
    }
    return { success: true };
  }
  
  // Get all permission keys (for UI)
  async getAllPermissionKeys() {
    await this.initialize();
    const result = await this.query(
      'SELECT DISTINCT permission_key FROM role_permissions ORDER BY permission_key'
    );
    return result.map(r => r.permission_key);
  }

  // ========== INVENTORY MANAGEMENT ==========
  
  // Get current inventory stock levels
  async getInventoryStock() {
    await this.initialize();
    return this.query(`
      SELECT 
        ist.id,
        ist.product_id,
        p.name as product_name,
        p.unit,
        p.unit_price,
        b.name as brand_name,
        ist.current_quantity,
        ist.last_in_date,
        ist.last_out_date,
        ist.updated_at
      FROM inventory_stock ist
      JOIN products p ON p.id = ist.product_id
      LEFT JOIN brands b ON b.id = p.brand_id
      ORDER BY p.name
    `);
  }
  
  // Get inventory transactions with filters
  async getInventoryTransactions(filters = {}) {
    await this.initialize();
    
    let sql = `
      SELECT 
        it.*,
        p.name as product_name,
        p.unit,
        b.name as brand_name,
        s.name as store_name,
        u.full_name as created_by_name,
        u.username as created_by_username,
        au.full_name as approved_by_name
      FROM inventory_transactions it
      JOIN products p ON p.id = it.product_id
      LEFT JOIN brands b ON b.id = p.brand_id
      LEFT JOIN stores s ON s.id = it.store_id
      JOIN users u ON u.id = it.created_by
      LEFT JOIN users au ON au.id = it.approved_by
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;
    
    if (filters.transaction_type) {
      sql += ` AND it.transaction_type = $${paramIndex++}`;
      params.push(filters.transaction_type);
    }
    if (filters.product_id) {
      sql += ` AND it.product_id = $${paramIndex++}`;
      params.push(filters.product_id);
    }
    if (filters.store_id) {
      sql += ` AND it.store_id = $${paramIndex++}`;
      params.push(filters.store_id);
    }
    if (filters.start_date) {
      sql += ` AND it.transaction_date >= $${paramIndex++}`;
      params.push(filters.start_date);
    }
    if (filters.end_date) {
      sql += ` AND it.transaction_date <= $${paramIndex++}`;
      params.push(filters.end_date);
    }
    if (filters.status) {
      sql += ` AND it.status = $${paramIndex++}`;
      params.push(filters.status);
    }
    
    sql += ' ORDER BY it.transaction_date DESC, it.created_at DESC';
    
    if (filters.limit) {
      sql += ` LIMIT $${paramIndex++}`;
      params.push(filters.limit);
    }
    
    return this.query(sql, params);
  }
  
  // Create inventory transaction (in or out)
  async createInventoryTransaction(data, userId) {
    await this.initialize();
    
    let actualQuantity = parseFloat(data.quantity) || 0;
    
    // For "out" transactions, reject if exceeds available stock
    if (data.transaction_type === 'out') {
      const stockResult = await this.query(
        `SELECT s.current_quantity, p.name as product_name 
         FROM inventory_stock s 
         JOIN products p ON p.id = s.product_id 
         WHERE s.product_id = $1`,
        [data.product_id]
      );
      const currentStock = stockResult.length > 0 ? parseFloat(stockResult[0].current_quantity) : 0;
      const productName = stockResult.length > 0 ? stockResult[0].product_name : '';
      
      // Reject if requested quantity exceeds available stock
      if (actualQuantity > currentStock) {
        return { success: false, error: 'لا يوجد رصيد كافٍ للإخراج', product_name: productName };
      }
    }
    
    const totalCost = actualQuantity * (parseFloat(data.unit_cost) || 0);
    
    const result = await this.query(
      `INSERT INTO inventory_transactions 
       (transaction_type, product_id, quantity, unit_cost, total_cost, reference_number, 
        supplier_name, store_id, note, transaction_date, created_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        data.transaction_type,
        data.product_id,
        actualQuantity,
        parseFloat(data.unit_cost) || 0,
        totalCost,
        data.reference_number || null,
        data.supplier_name || null,
        data.store_id || null,
        data.note || null,
        data.transaction_date,
        userId,
        data.status || 'approved'
      ]
    );
    
    const transactionId = result[0].id;
    
    // Update inventory stock
    await this.updateInventoryStock(data.product_id, data.transaction_type, actualQuantity);
    
    return { success: true, id: transactionId, actualQuantity };
  }
  
  // Update inventory stock based on transaction
  async updateInventoryStock(productId, transactionType, quantity) {
    await this.initialize();
    
    const qtyChange = transactionType === 'in' ? parseFloat(quantity) : -parseFloat(quantity);
    const dateField = transactionType === 'in' ? 'last_in_date' : 'last_out_date';
    
    // Check if stock record exists
    const existing = await this.query(
      'SELECT id, current_quantity FROM inventory_stock WHERE product_id = $1',
      [productId]
    );
    
    if (existing.length === 0) {
      // Create new stock record - only for 'in' transactions since 'out' should be capped already
      const newQty = Math.max(0, qtyChange);
      await this.execute(
        `INSERT INTO inventory_stock (product_id, current_quantity, ${dateField}, updated_at)
         VALUES ($1, $2, CURRENT_DATE, CURRENT_TIMESTAMP)`,
        [productId, newQty]
      );
    } else {
      // Update existing - cap at 0 to prevent negative stock from edge cases
      const newQty = Math.max(0, parseFloat(existing[0].current_quantity) + qtyChange);
      await this.execute(
        `UPDATE inventory_stock 
         SET current_quantity = $1, ${dateField} = CURRENT_DATE, updated_at = CURRENT_TIMESTAMP 
         WHERE product_id = $2`,
        [newQty, productId]
      );
    }
  }
  
  // Delete inventory transaction
  async deleteInventoryTransaction(transactionId, userId) {
    await this.initialize();
    
    // Get transaction details first
    const transaction = await this.query(
      'SELECT * FROM inventory_transactions WHERE id = $1',
      [transactionId]
    );
    
    if (transaction.length === 0) {
      return { success: false, error: 'Transaction not found' };
    }
    
    const tx = transaction[0];
    
    // Reverse the stock change
    const reverseType = tx.transaction_type === 'in' ? 'out' : 'in';
    await this.updateInventoryStock(tx.product_id, reverseType, tx.quantity);
    
    // Delete the transaction
    await this.execute('DELETE FROM inventory_transactions WHERE id = $1', [transactionId]);
    
    return { success: true };
  }
  
  // Get inventory transaction by ID
  async getInventoryTransactionById(id) {
    await this.initialize();
    const result = await this.query(`
      SELECT 
        it.*,
        p.name as product_name,
        p.unit,
        b.name as brand_name,
        s.name as store_name,
        u.full_name as created_by_name,
        au.full_name as approved_by_name
      FROM inventory_transactions it
      JOIN products p ON p.id = it.product_id
      LEFT JOIN brands b ON b.id = p.brand_id
      LEFT JOIN stores s ON s.id = it.store_id
      JOIN users u ON u.id = it.created_by
      LEFT JOIN users au ON au.id = it.approved_by
      WHERE it.id = $1
    `, [id]);
    return result[0] || null;
  }
  
  // Approve inventory transaction
  async approveInventoryTransaction(transactionId, userId) {
    await this.initialize();
    await this.execute(
      `UPDATE inventory_transactions 
       SET status = 'approved', approved_by = $1, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [userId, transactionId]
    );
    return { success: true };
  }
  
  // Cancel inventory transaction
  async cancelInventoryTransaction(transactionId, userId) {
    await this.initialize();
    
    // Get transaction details
    const transaction = await this.query(
      'SELECT * FROM inventory_transactions WHERE id = $1',
      [transactionId]
    );
    
    if (transaction.length === 0) {
      return { success: false, error: 'Transaction not found' };
    }
    
    const tx = transaction[0];
    
    // If it was approved, reverse the stock change
    if (tx.status === 'approved') {
      const reverseType = tx.transaction_type === 'in' ? 'out' : 'in';
      await this.updateInventoryStock(tx.product_id, reverseType, tx.quantity);
    }
    
    await this.execute(
      `UPDATE inventory_transactions 
       SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1`,
      [transactionId]
    );
    
    return { success: true };
  }
  
  // Get inventory summary report
  async getInventorySummary(startDate, endDate) {
    await this.initialize();
    
    return this.query(`
      SELECT 
        p.id as product_id,
        p.name as product_name,
        b.name as brand_name,
        COALESCE(ist.current_quantity, 0) as current_stock,
        COALESCE(SUM(CASE WHEN it.transaction_type = 'in' AND it.transaction_date >= $1 AND it.transaction_date <= $2 THEN it.quantity ELSE 0 END), 0) as total_in,
        COALESCE(SUM(CASE WHEN it.transaction_type = 'out' AND it.transaction_date >= $1 AND it.transaction_date <= $2 THEN it.quantity ELSE 0 END), 0) as total_out,
        COALESCE(SUM(CASE WHEN it.transaction_type = 'in' AND it.transaction_date >= $1 AND it.transaction_date <= $2 THEN it.total_cost ELSE 0 END), 0) as total_in_cost,
        COALESCE(SUM(CASE WHEN it.transaction_type = 'out' AND it.transaction_date >= $1 AND it.transaction_date <= $2 THEN it.total_cost ELSE 0 END), 0) as total_out_cost
      FROM products p
      LEFT JOIN brands b ON b.id = p.brand_id
      LEFT JOIN inventory_stock ist ON ist.product_id = p.id
      LEFT JOIN inventory_transactions it ON it.product_id = p.id AND it.status = 'approved'
      GROUP BY p.id, p.name, b.name, ist.current_quantity
      ORDER BY p.name
    `, [startDate, endDate]);
  }

  // Graceful shutdown
  async close() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

module.exports = Database;
