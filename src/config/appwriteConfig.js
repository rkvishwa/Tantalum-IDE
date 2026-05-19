/**
 * Appwrite Configuration
 * Configure your Appwrite project settings here
 */

const { Client, Account, Databases, Storage, ID, Query } = require('appwrite');
const sharedConfig = require('../../appwrite.config.json');

function deriveCollections(config) {
    if (config.collections && typeof config.collections === 'object') {
        return config.collections;
    }

    const tables = Array.isArray(config.tables) ? config.tables : [];
    return {
        boards: tables.find((table) => table.$id === 'boards')?.$id || 'boards',
        firmwares: tables.find((table) => table.$id === 'firmwares')?.$id || 'firmwares',
        sketches: tables.find((table) => table.$id === 'sketches')?.$id || 'sketches'
    };
}

function deriveDatabaseId(config) {
    if (typeof config.databaseId === 'string' && config.databaseId.length > 0) {
        return config.databaseId;
    }

    const tablesDb = Array.isArray(config.tablesDB) ? config.tablesDB : [];
    return tablesDb[0]?.$id || '';
}

function deriveFirmwareBucketId(config) {
    if (typeof config.firmwareBucketId === 'string' && config.firmwareBucketId.length > 0) {
        return config.firmwareBucketId;
    }

    const buckets = Array.isArray(config.buckets) ? config.buckets : [];
    return buckets.find((bucket) => bucket.$id === 'firmware_bucket')?.$id || buckets[0]?.$id || '';
}

// =============================================================================
// APPWRITE CONFIGURATION - UPDATE THESE VALUES
// =============================================================================

const APPWRITE_CONFIG = {
    // Appwrite endpoint - use Appwrite Cloud or your self-hosted instance
    endpoint: sharedConfig.endpoint,

    // Your Appwrite Project ID
    projectId: sharedConfig.projectId,

    // Database ID (create in Appwrite Console)
    databaseId: deriveDatabaseId(sharedConfig),

    // Collection IDs
    collections: deriveCollections(sharedConfig),

    // Storage Bucket ID for firmware files
    firmwareBucketId: deriveFirmwareBucketId(sharedConfig)
};

// =============================================================================
// APPWRITE CLIENT INITIALIZATION
// =============================================================================

const client = new Client();

client
    .setEndpoint(APPWRITE_CONFIG.endpoint)
    .setProject(APPWRITE_CONFIG.projectId);

// Initialize services
const account = new Account(client);
const databases = new Databases(client);
const storage = new Storage(client);

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    client,
    account,
    databases,
    storage,
    ID,
    Query,
    APPWRITE_CONFIG
};
