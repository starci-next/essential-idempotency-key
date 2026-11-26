-- Two databases in one Postgres container: `shop` (orders and the attempts log) and `payments` (wallets, charges, keys).
-- The shop never reads the payments database: it asks payments over HTTP.
CREATE DATABASE shop;
CREATE DATABASE payments;
