const bcrypt = require('bcrypt');

async function createAdmin() {
  const hash = await bcrypt.hash('admin123', 10);
  console.log(`DELETE FROM users WHERE username='admin';`);
  console.log(`INSERT INTO users (username, password, full_name, role, active) VALUES ('admin', '${hash}', 'Administrator', 'admin', 1);`);
}

createAdmin();
