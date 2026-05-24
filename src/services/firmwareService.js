/**
 * Firmware Service
 * Handles firmware upload, versioning, and OTA deployment
 */

const { databases, storage, ID, Query, APPWRITE_CONFIG } = require('../config/appwriteConfig');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { databaseId, collections, firmwareBucketId } = APPWRITE_CONFIG;

class FirmwareService {
    /**
     * Upload compiled firmware to cloud storage
     * @param {string} boardId - Target board ID
     * @param {Buffer} binaryData - Compiled firmware binary
     * @param {string} version - Firmware version
     * @param {string} filename - Original filename
     * @returns {Promise<Object>} Upload result
     */
    async uploadFirmware(boardId, binaryData, version, filename) {
        try {
            // Calculate checksum
            const checksum = crypto.createHash('sha256').update(binaryData).digest('hex');

            // Create a temporary file for upload
            const tempPath = path.join(require('os').tmpdir(), filename);
            fs.writeFileSync(tempPath, binaryData);

            // Upload to Appwrite Storage
            const file = await storage.createFile(
                firmwareBucketId,
                ID.unique(),
                fs.createReadStream(tempPath)
            );

            // Clean up temp file
            fs.unlinkSync(tempPath);

            // Create firmware record in database
            const firmware = await databases.createDocument(
                databaseId,
                collections.firmwares,
                ID.unique(),
                {
                    boardId,
                    version,
                    fileId: file.$id,
                    filename,
                    size: binaryData.length,
                    checksum,
                    uploadedAt: new Date().toISOString(),
                    deployed: false
                }
            );

            return { success: true, firmware, file };
        } catch (error) {
            console.error('Upload firmware error:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Deploy a specific firmware version to a board
     * @param {string} firmwareId - Firmware ID to deploy
     * @returns {Promise<Object>} Deployment result
     */
    async deployFirmware(firmwareId) {
        try {
            // Get firmware details
            const firmware = await databases.getDocument(
                databaseId,
                collections.firmwares,
                firmwareId
            );

            // Unset previous deployed firmware for this board
            const previousFirmwares = await databases.listDocuments(
                databaseId,
                collections.firmwares,
                [
                    Query.equal('boardId', firmware.boardId),
                    Query.equal('deployed', true),
                    Query.limit(100)
                ]
            );

            for (const prev of previousFirmwares.documents) {
                await databases.updateDocument(
                    databaseId,
                    collections.firmwares,
                    prev.$id,
                    { deployed: false }
                );
            }

            // Mark new firmware as deployed
            await databases.updateDocument(
                databaseId,
                collections.firmwares,
                firmwareId,
                { deployed: true }
            );

            // Queue desired firmware; the device gateway updates firmwareVersion only after OTA success.
            await databases.updateDocument(
                databaseId,
                collections.boards,
                firmware.boardId,
                {
                    desiredFirmwareId: firmware.$id,
                    desiredVersion: firmware.version,
                    desiredDeploymentId: `dep_${crypto.randomBytes(12).toString('hex')}`,
                    otaStatus: 'pending'
                }
            );

            return { success: true, firmware };
        } catch (error) {
            console.error('Deploy firmware error:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get the latest deployed firmware for a board
     * @param {string} boardId - Board ID
     * @returns {Promise<Object>} Latest firmware info
     */
    async getLatestFirmware(boardId) {
        try {
            const response = await databases.listDocuments(
                databaseId,
                collections.firmwares,
                [
                    Query.equal('boardId', boardId),
                    Query.equal('deployed', true),
                    Query.orderDesc('uploadedAt'),
                    Query.limit(1)
                ]
            );

            if (response.documents.length === 0) {
                return { success: true, firmware: null };
            }

            return { success: true, firmware: response.documents[0] };
        } catch (error) {
            console.error('Get latest firmware error:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get firmware download URL for OTA
     * @param {string} fileId - Storage file ID
     * @returns {Promise<Object>} Download URL
     */
    async getDownloadUrl(fileId) {
        try {
            const result = storage.getFileDownload(firmwareBucketId, fileId);
            return { success: true, url: result.href };
        } catch (error) {
            console.error('Get download URL error:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get firmware history for a board
     * @param {string} boardId - Board ID
     * @returns {Promise<Object>} List of firmwares
     */
    async getFirmwareHistory(boardId) {
        try {
            const response = await databases.listDocuments(
                databaseId,
                collections.firmwares,
                [
                    Query.equal('boardId', boardId),
                    Query.orderDesc('uploadedAt'),
                    Query.limit(50)
                ]
            );

            return { success: true, firmwares: response.documents };
        } catch (error) {
            console.error('Get firmware history error:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Delete a firmware version
     * @param {string} firmwareId - Firmware ID
     * @returns {Promise<Object>} Delete result
     */
    async deleteFirmware(firmwareId) {
        try {
            // Get firmware to find file ID
            const firmware = await databases.getDocument(
                databaseId,
                collections.firmwares,
                firmwareId
            );

            // Delete from storage
            await storage.deleteFile(firmwareBucketId, firmware.fileId);

            // Delete database record
            await databases.deleteDocument(
                databaseId,
                collections.firmwares,
                firmwareId
            );

            return { success: true };
        } catch (error) {
            console.error('Delete firmware error:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Check for firmware update (called by ESP32)
     * @param {string} apiToken - Board API token
     * @param {string} currentVersion - Board's current firmware version
     * @returns {Promise<Object>} Update info if available
     */
    async checkForUpdate(apiToken, currentVersion) {
        try {
            // Find board by API token
            const boardResponse = await databases.listDocuments(
                databaseId,
                collections.boards,
                [Query.equal('apiToken', apiToken)]
            );

            if (boardResponse.documents.length === 0) {
                return { success: false, error: 'Invalid API token' };
            }

            const board = boardResponse.documents[0];

            // Get latest deployed firmware
            const latestResult = await this.getLatestFirmware(board.$id);

            if (!latestResult.success || !latestResult.firmware) {
                return { success: true, updateAvailable: false };
            }

            const firmware = latestResult.firmware;

            // Compare versions
            if (this.compareVersions(firmware.version, currentVersion) > 0) {
                const downloadUrl = await this.getDownloadUrl(firmware.fileId);

                return {
                    success: true,
                    updateAvailable: true,
                    firmware: {
                        version: firmware.version,
                        size: firmware.size,
                        checksum: firmware.checksum,
                        downloadUrl: downloadUrl.url
                    }
                };
            }

            return { success: true, updateAvailable: false };
        } catch (error) {
            console.error('Check for update error:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Compare semantic versions
     * @param {string} v1 - Version 1
     * @param {string} v2 - Version 2
     * @returns {number} 1 if v1 > v2, -1 if v1 < v2, 0 if equal
     */
    compareVersions(v1, v2) {
        const parts1 = v1.split('.').map(Number);
        const parts2 = v2.split('.').map(Number);

        for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
            const p1 = parts1[i] || 0;
            const p2 = parts2[i] || 0;

            if (p1 > p2) return 1;
            if (p1 < p2) return -1;
        }

        return 0;
    }
}

module.exports = new FirmwareService();
