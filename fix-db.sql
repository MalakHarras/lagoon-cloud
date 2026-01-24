-- Fix all users with NULL active status
UPDATE users SET active = 1 WHERE active IS NULL;

-- Show all users
SELECT id, username, full_name, role, manager_id, active FROM users ORDER BY id;
