/* =====================================================================
   RentHome migration for an EXISTING database (renthome_db).
   Safe to run more than once: every step checks first, so "already there" is fine.
   Run the whole file in MySQL Workbench (or: mysql -u root -p renthome_db < migration.sql)
   Take a backup of the database before you run it.
   ===================================================================== */
USE renthome_db;
SET SQL_SAFE_UPDATES = 0;

/* 0. Remove the identity trigger first, so the ID can be filled in below. It is created again at the end. */
DROP TRIGGER IF EXISTS properties_keep_identity;

/* 1. properties.image_urls (up to 8 photo links) */
SET @n := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='properties' AND COLUMN_NAME='image_urls');
SET @sql := IF(@n=0, 'ALTER TABLE properties ADD COLUMN image_urls TEXT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

/* 2. properties.house_type (the written "Type") */
SET @n := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='properties' AND COLUMN_NAME='house_type');
SET @sql := IF(@n=0, 'ALTER TABLE properties ADD COLUMN house_type VARCHAR(100) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

/* 3. properties.listing_uid (permanent listing ID made by the database) */
SET @n := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='properties' AND COLUMN_NAME='listing_uid');
SET @sql := IF(@n=0, 'ALTER TABLE properties ADD COLUMN listing_uid CHAR(36) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

UPD);ATE properties SET listing_uid = UUID() WHERE listing_uid IS NULL;
ALTER TABLE properties MODIFY listing_uid CHAR(36) NOT NULL;

SET @n := (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='properties' AND INDEX_NAME='uq_listing_uid');
SET @sql := IF(@n=0, 'ALTER TABLE properties ADD UNIQUE KEY uq_listing_uid (listing_uid)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

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


/* 5. subscriptions.trial_ends (the free management trial) */
SET @n := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='subscriptions' AND COLUMN_NAME='trial_ends');
SET @sql := IF(@n=0, 'ALTER TABLE subscriptions ADD COLUMN trial_ends DATE NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

/* 6. The listing ID and the owner of a house can never change */
CREATE TRIGGER properties_keep_identity BEFORE UPDATE ON properties
FOR EACH ROW SET NEW.listing_uid = OLD.listing_uid, NEW.landlord_id = OLD.landlord_id;

/* 7. Optional, only while you are testing: forget old trial dates so they are worked out again
      from each landlord's first listing. To run it, remove the two dashes at the start of the next line. */
-- UPDATE subscriptions SET trial_ends = NULL;

SELECT 'Migration finished' AS result;
