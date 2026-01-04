/**
 * Bibliac - Files Module
 *
 * Provides download queue, download strategies, and file management.
 */

// Re-export constants
const constants = require('./constants.cjs');
module.exports = { ...constants };

// Re-export DownloadQueue
const { DownloadQueue } = require('./download-queue.cjs');
module.exports.DownloadQueue = DownloadQueue;

// Re-export download strategies
const strategies = require('./download-strategies.cjs');
module.exports.BaseDownloader = strategies.BaseDownloader;
module.exports.ArxivDownloader = strategies.ArxivDownloader;
module.exports.PublisherDownloader = strategies.PublisherDownloader;
module.exports.AdsDownloader = strategies.AdsDownloader;
module.exports.DownloadStrategyManager = strategies.DownloadStrategyManager;

// Re-export FileManager
const { FileManager } = require('./file-manager.cjs');
module.exports.FileManager = FileManager;
