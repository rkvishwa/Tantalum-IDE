/**
 * Board Management Service
 * Handles CRUD operations for user's development boards
 */

const { databases, ID, Query, APPWRITE_CONFIG } = require('../config/appwriteConfig');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const { databaseId, collections } = APPWRITE_CONFIG;

class BoardService {
    /**
     * Create a new board registration
     * @param {string} userId - Owner user ID
     * @param {Object} boardData - Board configuration
     * @returns {Promise<Object>} Created board
     */
    async createBoard(userId, boardData) {
        try {
            const apiToken = this.generateApiToken();

            const board = await databases.createDocument(
                databaseId,
                collections.boards,
                ID.unique(),
                {
                    userId,
                    name: boardData.name,
                    boardType: boardData.boardType,
                    apiToken,
                    firmwareVersion: '0.0.0',
                    desiredFirmwareId: '',
                    desiredVersion: '',
                    desiredDeploymentId: '',
                    lastAppliedDeploymentId: '',
                    runtimeVersion: '',
                    lastUpdateCheckAt: null,
                    otaStatus: 'idle',
                    provisioningStatus: 'pending',
                    provisioningRequestedAt: null,
                    provisioningMode: '',
                    lastOtaError: '',
                    sourceCodeVisibility: boardData.sourceCodeVisibility === 'public' ? 'public' : 'private',
                    lastSeen: null,
                    status: 'pending',
                    createdAt: new Date().toISOString()
                }
            );

            return { success: true, board };
        } catch (error) {
            console.error('Create board error:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get all boards for a user
     * @param {string} userId - User ID
     * @returns {Promise<Object>} List of boards
     */
    async listBoards(userId) {
        try {
            const response = await databases.listDocuments(
                databaseId,
                collections.boards,
                [
                    Query.equal('userId', userId),
                    Query.orderDesc('createdAt'),
                    Query.limit(100)
                ]
            );

            return { success: true, boards: response.documents };
        } catch (error) {
            console.error('List boards error:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get a single board by ID
     * @param {string} boardId - Board ID
     * @returns {Promise<Object>} Board object
     */
    async getBoard(boardId) {
        try {
            const board = await databases.getDocument(
                databaseId,
                collections.boards,
                boardId
            );

            return { success: true, board };
        } catch (error) {
            console.error('Get board error:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Update board settings
     * @param {string} boardId - Board ID
     * @param {Object} updates - Fields to update
     * @returns {Promise<Object>} Updated board
     */
    async updateBoard(boardId, updates) {
        try {
            // Prevent updating sensitive fields
            const allowedFields = ['name', 'status', 'lastSeen', 'firmwareVersion', 'desiredFirmwareId', 'desiredVersion', 'desiredDeploymentId', 'lastAppliedDeploymentId', 'runtimeVersion', 'lastUpdateCheckAt', 'otaStatus', 'provisioningStatus', 'provisioningRequestedAt', 'provisioningMode', 'lastOtaError', 'sourceCodeVisibility'];
            const safeUpdates = {};

            for (const key of allowedFields) {
                if (updates[key] !== undefined) {
                    safeUpdates[key] = updates[key];
                }
            }

            const board = await databases.updateDocument(
                databaseId,
                collections.boards,
                boardId,
                safeUpdates
            );

            return { success: true, board };
        } catch (error) {
            console.error('Update board error:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Delete a board
     * @param {string} boardId - Board ID
     * @returns {Promise<Object>} Success status
     */
    async deleteBoard(boardId) {
        try {
            await databases.deleteDocument(
                databaseId,
                collections.boards,
                boardId
            );

            return { success: true };
        } catch (error) {
            console.error('Delete board error:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Generate a secure API token for board authentication
     * @returns {string} API token
     */
    generateApiToken() {
        return `board_${uuidv4().replace(/-/g, '')}_${crypto.randomBytes(16).toString('hex')}`;
    }

    /**
     * Regenerate API token for a board
     * @param {string} boardId - Board ID
     * @returns {Promise<Object>} New token
     */
    async regenerateToken(boardId) {
        try {
            const newToken = this.generateApiToken();

            await databases.updateDocument(
                databaseId,
                collections.boards,
                boardId,
                { apiToken: newToken }
            );

            return { success: true, apiToken: newToken };
        } catch (error) {
            console.error('Regenerate token error:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Update board heartbeat (called by ESP32)
     * @param {string} apiToken - Board API token
     * @returns {Promise<Object>} Update result
     */
    async heartbeat(apiToken) {
        try {
            // Find board by API token
            const response = await databases.listDocuments(
                databaseId,
                collections.boards,
                [Query.equal('apiToken', apiToken)]
            );

            if (response.documents.length === 0) {
                return { success: false, error: 'Invalid API token' };
            }

            const board = response.documents[0];

            await databases.updateDocument(
                databaseId,
                collections.boards,
                board.$id,
                {
                    lastSeen: new Date().toISOString(),
                    status: 'online'
                }
            );

            return { success: true };
        } catch (error) {
            console.error('Heartbeat error:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get board status based on last heartbeat
     * @param {Object} board - Board object
     * @returns {string} 'online' | 'offline' | 'pending'
     */
    calculateStatus(board) {
        if (board.status === 'pending') return 'pending';
        if (!board.lastSeen) return 'offline';

        const lastSeen = new Date(board.lastSeen);
        const now = new Date();
        const diffMinutes = (now - lastSeen) / (1000 * 60);

        // Match the renderer grace period so transient WiFi or gateway delays do not
        // make the same board disagree between local services and the UI.
        return diffMinutes <= 5 ? 'online' : 'offline';
    }
}

module.exports = new BoardService();
