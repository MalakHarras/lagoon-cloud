#!/bin/bash
# Setup script for domain and SSL

DOMAIN="njnn7rtg76873c4u83cm9.xyz"
EMAIL="your-email@example.com"  # Change this to your email

echo "Installing Nginx and Certbot..."
dnf install -y nginx certbot python3-certbot-nginx

echo "Creating Nginx configuration..."
cat > /etc/nginx/conf.d/lagoon.conf << 'EOF'
server {
    listen 80;
    server_name njnn7rtg76873c4u83cm9.xyz www.njnn7rtg76873c4u83cm9.xyz;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # CORS headers
        add_header 'Access-Control-Allow-Origin' '*' always;
        add_header 'Access-Control-Allow-Methods' 'GET, POST, PUT, DELETE, OPTIONS' always;
        add_header 'Access-Control-Allow-Headers' 'Authorization, Content-Type' always;
        
        # Handle preflight
        if ($request_method = 'OPTIONS') {
            return 204;
        }
    }
}
EOF

echo "Starting Nginx..."
systemctl enable nginx
systemctl start nginx

echo "Opening firewall ports..."
firewall-cmd --permanent --add-service=http
firewall-cmd --permanent --add-service=https
firewall-cmd --reload

echo "Waiting for DNS propagation..."
echo "Please wait 5-10 minutes for DNS to propagate, then run:"
echo "sudo certbot --nginx -d $DOMAIN -d www.$DOMAIN --email $EMAIL --agree-tos --non-interactive"
