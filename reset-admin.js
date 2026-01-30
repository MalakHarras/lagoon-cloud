const db = require('./db-postgres');
const bcrypt = require('bcrypt');

(async () => {
  try {
    await db.initialize();
    
    const password = '06911653@';
    const hash = await bcrypt.hash(password, 10);
    
    console.log('Generated hash:', hash);
    
    await db.execute(
      "UPDATE users SET password = $1 WHERE username = 'MohamedHarras'",
      [hash]
    );
    
    console.log('Password updated successfully for MohamedHarras');
    process.exit(0);
  } catch (e) {
    console.error('Error:', e);
    process.exit(1);
  }
})();
