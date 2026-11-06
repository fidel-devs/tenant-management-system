CREATE DATABASE IF NOT EXISTS renthome_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE renthome_db;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  full_name VARCHAR(120) NOT NULL,
  email VARCHAR(190) NOT NULL UNIQUE,
  phone VARCHAR(20) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('landlord','tenant') NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS properties (
  id INT AUTO_INCREMENT PRIMARY KEY,
  listing_uid CHAR(36) NOT NULL,                 -- permanent listing ID, made by the database (UUID())
  landlord_id INT NOT NULL,
  title VARCHAR(160) NOT NULL,
  description TEXT,
  county VARCHAR(100) NOT NULL,
  town VARCHAR(100) NOT NULL,
  address VARCHAR(255),
  monthly_rent DECIMAL(12,2) NOT NULL,
  bedrooms INT NOT NULL DEFAULT 1,
  bathrooms INT NOT NULL DEFAULT 1,
  house_type VARCHAR(100) NULL,                  -- written "Type", e.g. Bedsitter
  image_url VARCHAR(500),                        -- main photo
  image_urls TEXT NULL,                          -- JSON list of up to 8 photo links
  status ENUM('available','occupied','hidden') NOT NULL DEFAULT 'available',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (landlord_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uq_listing_uid (listing_uid),
  INDEX idx_property_search (county, town, status)
);

CREATE TABLE IF NOT EXISTS tenancies (
  id INT AUTO_INCREMENT PRIMARY KEY,
  property_id INT NOT NULL,
  landlord_id INT NOT NULL,
  tenant_id INT NOT NULL,
  house_number VARCHAR(30) NULL,
  start_date DATE NOT NULL,
  end_date DATE NULL,
  monthly_rent DECIMAL(12,2) NOT NULL,
  rent_due_day TINYINT NOT NULL DEFAULT 5,
  status ENUM('active','ended') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (property_id) REFERENCES properties(id),
  FOREIGN KEY (landlord_id) REFERENCES users(id),
  FOREIGN KEY (tenant_id) REFERENCES users(id),
  INDEX idx_tenancy_tenant (tenant_id, status),
  INDEX idx_tenancy_landlord (landlord_id, status)
);

CREATE TABLE IF NOT EXISTS payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenancy_id INT NOT NULL,
  tenant_id INT NOT NULL,
  landlord_id INT NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  method ENUM('cash','bank','mpesa','other') NOT NULL,
  reference VARCHAR(100) NULL,
  period_month CHAR(7) NOT NULL,
  status ENUM('pending','paid','failed') NOT NULL DEFAULT 'paid',
  recorded_by INT NOT NULL,
  mpesa_checkout_id VARCHAR(100) NULL,
  mpesa_receipt VARCHAR(50) NULL,
  note VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenancy_id) REFERENCES tenancies(id),
  FOREIGN KEY (tenant_id) REFERENCES users(id),
  FOREIGN KEY (landlord_id) REFERENCES users(id),
  FOREIGN KEY (recorded_by) REFERENCES users(id),
  UNIQUE KEY unique_mpesa_checkout (mpesa_checkout_id),
  INDEX idx_payment_tenancy_period (tenancy_id, period_month, status)
);

CREATE TABLE IF NOT EXISTS maintenance_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenancy_id INT NOT NULL,
  tenant_id INT NOT NULL,
  title VARCHAR(160) NOT NULL,
  description TEXT,
  status ENUM('open','in_progress','completed') NOT NULL DEFAULT 'open',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenancy_id) REFERENCES tenancies(id),
  FOREIGN KEY (tenant_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS expenses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  landlord_id INT NOT NULL,
  property_id INT NULL,
  amount DECIMAL(12,2) NOT NULL,
  category VARCHAR(100) NOT NULL,
  description VARCHAR(255),
  expense_date DATE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (landlord_id) REFERENCES users(id),
  FOREIGN KEY (property_id) REFERENCES properties(id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  action VARCHAR(120) NOT NULL,
  details TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  type VARCHAR(40) NOT NULL,
  message VARCHAR(255) NOT NULL,
  payment_id INT NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE SET NULL,
  INDEX idx_notif_user (user_id, is_read, created_at)
);

CREATE TABLE IF NOT EXISTS rent_reminders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenancy_id INT NOT NULL,
  due_date DATE NOT NULL,
  sent_on DATE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_reminder_day (tenancy_id, due_date, sent_on),
  FOREIGN KEY (tenancy_id) REFERENCES tenancies(id) ON DELETE CASCADE
);

/* Each landlord's own M-Pesa details (the keys are stored encrypted by the server) */
CREATE TABLE IF NOT EXISTS landlord_mpesa (
  landlord_id INT NOT NULL PRIMARY KEY,
  txn_type ENUM('paybill','till') NOT NULL DEFAULT 'paybill',
  shortcode VARCHAR(20) NOT NULL,
  till_number VARCHAR(20) NULL,
  env ENUM('sandbox','production') NOT NULL DEFAULT 'sandbox',
  passkey_enc TEXT NOT NULL,
  consumer_key_enc TEXT NOT NULL,
  consumer_secret_enc TEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (landlord_id) REFERENCES users(id) ON DELETE CASCADE
);

/* Monthly plan: paid_until = end of the paid plan, trial_ends = end of the free management trial
   (set from the day of the landlord's first listing) */
CREATE TABLE IF NOT EXISTS subscriptions (
  landlord_id INT NOT NULL PRIMARY KEY,
  paid_until DATE NULL,
  trial_ends DATE NULL,
  FOREIGN KEY (landlord_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS subscription_payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  landlord_id INT NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  checkout_id VARCHAR(100) NOT NULL,
  merchant_id VARCHAR(100) NULL,
  receipt VARCHAR(50) NULL,
  status ENUM('pending','paid','failed') NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (checkout_id),
  FOREIGN KEY (landlord_id) REFERENCES users(id) ON DELETE CASCADE
);

/* A landlord cannot change a house's address himself: he sends a request and an admin decides */
CREATE TABLE IF NOT EXISTS address_change_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  property_id INT NOT NULL,
  landlord_id INT NOT NULL,
  new_county VARCHAR(100) NOT NULL,
  new_town VARCHAR(100) NOT NULL,
  new_address VARCHAR(255) NOT NULL,
  note TEXT NULL,
  status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  admin_id INT NULL,
  admin_note VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TIMESTAMP NULL,
  INDEX (property_id),
  INDEX (status),
  FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE,
  FOREIGN KEY (landlord_id) REFERENCES users(id) ON DELETE CASCADE
);

/* 4. Tables (created only if they are missing) */
CREATE TABLE IF NOT EXISTS landlord_mpesa (
  landlord_id INT NOT NULL PRIMARY KEY,
  txn_type ENUM('paybill','till') NOT NULL DEFAULT 'paybill',
  shortcode VARCHAR(20) NOT NULL,
  till_number VARCHAR(20) NULL,
  env ENUM('sandbox','production') NOT NULL DEFAULT 'sandbox',
  passkey_enc TEXT NOT NULL,
  consumer_key_enc TEXT NOT NULL,
  consumer_secret_enc TEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS subscriptions (
  landlord_id INT NOT NULL PRIMARY KEY,
  paid_until DATE NULL,
  trial_ends DATE NULL
);

CREATE TABLE IF NOT EXISTS subscription_payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  landlord_id INT NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  checkout_id VARCHAR(100) NOT NULL,
  merchant_id VARCHAR(100) NULL,
  receipt VARCHAR(50) NULL,
  status ENUM('pending','paid','failed') NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (checkout_id)
);

CREATE TABLE IF NOT EXISTS address_change_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  property_id INT NOT NULL,
  landlord_id INT NOT NULL,
  new_county VARCHAR(100) NOT NULL,
  new_town VARCHAR(100) NOT NULL,
  new_address VARCHAR(255) NOT NULL,
  note TEXT NULL,
  status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  admin_id INT NULL,
  admin_note VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TIMESTAMP NULL,
  INDEX (property_id),
  INDEX (status)
);

CREATE TABLE IF NOT EXISTS password_resets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX (token_hash),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

/* The listing ID and the owner of a house can never change, whatever the code does */
DROP TRIGGER IF EXISTS properties_keep_identity;
CREATE TRIGGER properties_keep_identity BEFORE UPDATE ON properties
FOR EACH ROW SET NEW.listing_uid = OLD.listing_uid, NEW.landlord_id = OLD.landlord_id;
