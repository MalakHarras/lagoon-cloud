const db = require('./db-postgres');

(async () => {
  try {
    await db.initialize();
    
    console.log('Testing getDirectSubordinatesOnly(1):');
    const result = await db.getDirectSubordinatesOnly(1);
    console.log(JSON.stringify(result, null, 2));
    
    process.exit(0);
  } catch (e) {
    console.error('Error:', e);
    process.exit(1);
  }
})();
