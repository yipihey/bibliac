/**
 * Bibliac - Download Queue
 *
 * A decoupled download queue that handles PDF downloads separately from metadata sync.
 * Features retry logic, progress events, and priority-based ordering.
 */

const EventEmitter = require('events');
const {
  FILE_STATUS,
  PRIORITY,
  DEFAULT_RETRY_POLICY,
  DEFAULT_CONCURRENCY
} = require('./constants.cjs');

/**
 * @typedef {Object} QueueItem
 * @property {string} paperId - Paper identifier (usually bibcode)
 * @property {string} sourceType - Preferred download source (arxiv, publisher, ads_scan, auto)
 * @property {number} priority - Priority level for ordering
 * @property {number} attempt - Current attempt number
 * @property {number} addedAt - Timestamp when added to queue
 * @property {Object} paper - Paper metadata (populated when download starts)
 */

/**
 * @typedef {Object} ActiveDownload
 * @property {string} paperId - Paper identifier
 * @property {string} sourceType - Download source being used
 * @property {number} startedAt - Timestamp when download started
 * @property {number} bytesReceived - Bytes downloaded so far
 * @property {number} totalBytes - Total file size (if known)
 * @property {AbortController} abortController - For cancellation
 */

/**
 * @typedef {Object} QueueStatus
 * @property {number} queued - Number of items waiting in queue
 * @property {number} active - Number of active downloads
 * @property {boolean} paused - Whether queue is paused
 * @property {string[]} activeIds - Paper IDs currently downloading
 */

class DownloadQueue extends EventEmitter {
  /**
   * Create a new DownloadQueue
   * @param {Object} options - Configuration options
   * @param {number} [options.concurrency=2] - Max concurrent downloads
   * @param {Object} [options.retryPolicy] - Retry configuration
   * @param {Function} [options.downloadFn] - The actual download function
   * @param {Function} [options.getPaperFn] - Function to get paper metadata by ID
   */
  constructor(options = {}) {
    super();

    this.concurrency = options.concurrency || DEFAULT_CONCURRENCY;
    this.retryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retryPolicy };

    // The actual download implementation (injected dependency)
    this.downloadFn = options.downloadFn || null;

    // Function to get paper metadata
    this.getPaperFn = options.getPaperFn || null;

    // Queue of items waiting to be processed
    this.queue = [];

    // Currently active downloads: paperId -> ActiveDownload
    this.active = new Map();

    // Items that have been cancelled (to prevent re-processing)
    this.cancelled = new Set();

    // Pause state
    this.paused = false;

    // Processing state
    this._processing = false;
  }

  /**
   * Set the download function (for dependency injection)
   * @param {Function} fn - Download function (paper, sourceType, onProgress) => Promise<result>
   */
  setDownloadFn(fn) {
    this.downloadFn = fn;
  }

  /**
   * Set the paper lookup function
   * @param {Function} fn - Function (paperId) => Promise<paper>
   */
  setGetPaperFn(fn) {
    this.getPaperFn = fn;
  }

  /**
   * Add a paper to the download queue
   * @param {string} paperId - Paper identifier (usually bibcode)
   * @param {string} [sourceType='auto'] - Preferred source (arxiv, publisher, ads_scan, auto)
   * @param {number} [priority=PRIORITY.NORMAL] - Priority level
   * @returns {number} Position in queue (0-indexed)
   */
  enqueue(paperId, sourceType = 'auto', priority = PRIORITY.NORMAL) {
    // Don't add if already in queue or active
    if (this._isQueued(paperId) || this.active.has(paperId)) {
      console.log(`[DownloadQueue] ${paperId} already in queue or active, skipping`);
      return -1;
    }

    // Remove from cancelled set if re-enqueuing
    this.cancelled.delete(paperId);

    const item = {
      paperId,
      sourceType,
      priority,
      attempt: 0,
      addedAt: Date.now(),
      paper: null
    };

    // Insert maintaining priority order (higher priority first)
    let insertIndex = this.queue.findIndex(q => q.priority < priority);
    if (insertIndex === -1) {
      insertIndex = this.queue.length;
    }
    this.queue.splice(insertIndex, 0, item);

    console.log(`[DownloadQueue] Enqueued ${paperId} at position ${insertIndex}`);

    this.emit('queued', {
      paperId,
      sourceType,
      position: insertIndex
    });

    // Start processing if not at capacity
    this._processNext();

    return insertIndex;
  }

  /**
   * Add multiple papers to the queue
   * @param {string[]} paperIds - Array of paper identifiers
   * @param {string} [sourceType='auto'] - Preferred source
   * @param {number} [priority=PRIORITY.NORMAL] - Priority level
   * @returns {number} Number of papers added
   */
  enqueueMany(paperIds, sourceType = 'auto', priority = PRIORITY.NORMAL) {
    let added = 0;
    for (const paperId of paperIds) {
      if (this.enqueue(paperId, sourceType, priority) >= 0) {
        added++;
      }
    }
    return added;
  }

  /**
   * Cancel a specific download
   * @param {string} paperId - Paper identifier to cancel
   * @returns {boolean} True if found and cancelled
   */
  cancel(paperId) {
    // Add to cancelled set
    this.cancelled.add(paperId);

    // Remove from queue
    const queueIndex = this.queue.findIndex(item => item.paperId === paperId);
    if (queueIndex !== -1) {
      this.queue.splice(queueIndex, 1);
      console.log(`[DownloadQueue] Cancelled queued download for ${paperId}`);
      this.emit('cancelled', { paperId, wasActive: false });
      return true;
    }

    // Abort active download
    const activeDownload = this.active.get(paperId);
    if (activeDownload) {
      if (activeDownload.abortController) {
        activeDownload.abortController.abort();
      }
      this.active.delete(paperId);
      console.log(`[DownloadQueue] Cancelled active download for ${paperId}`);
      this.emit('cancelled', { paperId, wasActive: true });

      // Process next item since we freed a slot
      this._processNext();
      return true;
    }

    return false;
  }

  /**
   * Cancel all downloads
   * @returns {number} Number of downloads cancelled
   */
  cancelAll() {
    let count = 0;

    // Cancel all queued items
    for (const item of this.queue) {
      this.cancelled.add(item.paperId);
      count++;
    }
    this.queue = [];

    // Abort all active downloads
    for (const [paperId, download] of this.active) {
      this.cancelled.add(paperId);
      if (download.abortController) {
        download.abortController.abort();
      }
      count++;
    }
    this.active.clear();

    if (count > 0) {
      console.log(`[DownloadQueue] Cancelled ${count} downloads`);
      this.emit('cancelled-all', { count });
    }

    return count;
  }

  /**
   * Pause the queue (active downloads continue)
   */
  pause() {
    if (!this.paused) {
      this.paused = true;
      console.log('[DownloadQueue] Queue paused');
      this.emit('paused');
    }
  }

  /**
   * Resume the queue
   */
  resume() {
    if (this.paused) {
      this.paused = false;
      console.log('[DownloadQueue] Queue resumed');
      this.emit('resumed');
      this._processNext();
    }
  }

  /**
   * Get current queue status
   * @returns {QueueStatus}
   */
  getStatus() {
    return {
      queued: this.queue.length,
      active: this.active.size,
      paused: this.paused,
      activeIds: Array.from(this.active.keys())
    };
  }

  /**
   * Get detailed info about queued items
   * @returns {Array<{paperId: string, sourceType: string, priority: number, position: number}>}
   */
  getQueuedItems() {
    return this.queue.map((item, index) => ({
      paperId: item.paperId,
      sourceType: item.sourceType,
      priority: item.priority,
      position: index,
      attempt: item.attempt
    }));
  }

  /**
   * Get info about active downloads
   * @returns {Array<{paperId: string, sourceType: string, bytesReceived: number, totalBytes: number, percent: number}>}
   */
  getActiveDownloads() {
    const result = [];
    for (const [paperId, download] of this.active) {
      const percent = download.totalBytes > 0
        ? Math.round((download.bytesReceived / download.totalBytes) * 100)
        : 0;
      result.push({
        paperId,
        sourceType: download.sourceType,
        bytesReceived: download.bytesReceived,
        totalBytes: download.totalBytes,
        percent
      });
    }
    return result;
  }

  /**
   * Check if a paper is in the queue
   * @private
   */
  _isQueued(paperId) {
    return this.queue.some(item => item.paperId === paperId);
  }

  /**
   * Process the next item in the queue
   * @private
   */
  async _processNext() {
    // Don't start new downloads if paused
    if (this.paused) return;

    // Don't start if already at capacity
    if (this.active.size >= this.concurrency) return;

    // Don't start if queue is empty
    if (this.queue.length === 0) {
      // Emit queue-empty when all downloads complete
      if (this.active.size === 0 && !this._processing) {
        this.emit('queue-empty');
      }
      return;
    }

    // Prevent re-entry
    if (this._processing) return;
    this._processing = true;

    try {
      // Take next item from queue
      const item = this.queue.shift();

      // Skip if cancelled
      if (this.cancelled.has(item.paperId)) {
        this.cancelled.delete(item.paperId);
        this._processing = false;
        this._processNext();
        return;
      }

      // Start download
      await this._downloadWithRetry(item);
    } finally {
      this._processing = false;
    }

    // Process more if capacity allows
    if (this.active.size < this.concurrency && this.queue.length > 0) {
      this._processNext();
    }
  }

  /**
   * Download with retry logic
   * @private
   * @param {QueueItem} item - Queue item to download
   */
  async _downloadWithRetry(item) {
    const { paperId, sourceType } = item;

    // Check if download function is set
    if (!this.downloadFn) {
      console.error('[DownloadQueue] No download function set');
      this.emit('error', {
        paperId,
        sourceType,
        error: new Error('Download function not configured'),
        willRetry: false,
        attempt: item.attempt
      });
      return;
    }

    // Get paper metadata if needed
    let paper = item.paper;
    if (!paper && this.getPaperFn) {
      try {
        paper = await this.getPaperFn(paperId);
        item.paper = paper;
      } catch (err) {
        console.error(`[DownloadQueue] Failed to get paper ${paperId}:`, err.message);
        this.emit('error', {
          paperId,
          sourceType,
          error: new Error(`Failed to get paper metadata: ${err.message}`),
          willRetry: false,
          attempt: item.attempt
        });
        this._processNext();
        return;
      }
    }

    if (!paper) {
      console.error(`[DownloadQueue] No paper metadata for ${paperId}`);
      this.emit('error', {
        paperId,
        sourceType,
        error: new Error('Paper not found'),
        willRetry: false,
        attempt: item.attempt
      });
      this._processNext();
      return;
    }

    // Create abort controller
    const abortController = new AbortController();

    // Track active download
    const activeDownload = {
      paperId,
      sourceType,
      startedAt: Date.now(),
      bytesReceived: 0,
      totalBytes: 0,
      abortController
    };
    this.active.set(paperId, activeDownload);

    console.log(`[DownloadQueue] Starting download for ${paperId} (attempt ${item.attempt + 1})`);

    this.emit('started', {
      paperId,
      sourceType,
      attempt: item.attempt + 1
    });

    // Progress callback
    const onProgress = (bytesReceived, totalBytes) => {
      const download = this.active.get(paperId);
      if (download) {
        download.bytesReceived = bytesReceived;
        download.totalBytes = totalBytes;
      }

      const percent = totalBytes > 0
        ? Math.round((bytesReceived / totalBytes) * 100)
        : 0;

      this.emit('progress', {
        paperId,
        sourceType,
        bytesReceived,
        totalBytes,
        percent
      });
    };

    try {
      // Perform the download
      const result = await this.downloadFn(paper, sourceType, onProgress, abortController.signal);

      // Remove from active
      this.active.delete(paperId);

      // Check if cancelled during download
      if (this.cancelled.has(paperId)) {
        this.cancelled.delete(paperId);
        console.log(`[DownloadQueue] Download for ${paperId} was cancelled during download`);
        this._processNext();
        return;
      }

      if (result.success) {
        console.log(`[DownloadQueue] Download complete for ${paperId}`);
        this.emit('complete', {
          paperId,
          sourceType: result.source || sourceType,
          fileId: result.fileId,
          path: result.path,
          size: result.size
        });
      } else {
        // Check if browser-based download is needed (publisher auth)
        if (result.needsBrowser) {
          console.log(`[DownloadQueue] ${paperId} needs browser-based download`);
          this.emit('error', {
            paperId,
            sourceType,
            error: new Error(result.error || 'Authentication required'),
            willRetry: false,
            attempt: item.attempt,
            needsBrowser: true
          });
          this._processNext();
          return;
        }
        throw new Error(result.error || result.reason || 'Download failed');
      }
    } catch (error) {
      // Remove from active
      this.active.delete(paperId);

      // Check if cancelled
      if (this.cancelled.has(paperId) || error.name === 'AbortError') {
        this.cancelled.delete(paperId);
        console.log(`[DownloadQueue] Download for ${paperId} was aborted`);
        this._processNext();
        return;
      }

      // Check if we should retry
      item.attempt++;
      const maxAttempts = this.retryPolicy.maxAttempts;
      const willRetry = item.attempt < maxAttempts;

      console.error(`[DownloadQueue] Download failed for ${paperId}:`, error.message);

      this.emit('error', {
        paperId,
        sourceType,
        error,
        willRetry,
        attempt: item.attempt
      });

      if (willRetry) {
        // Calculate backoff delay
        const backoffIndex = Math.min(item.attempt - 1, this.retryPolicy.backoff.length - 1);
        const delay = this.retryPolicy.backoff[backoffIndex];

        console.log(`[DownloadQueue] Will retry ${paperId} in ${delay}ms (attempt ${item.attempt + 1}/${maxAttempts})`);

        // Re-add to queue after delay
        setTimeout(() => {
          if (!this.cancelled.has(paperId)) {
            // Insert at front of queue for retry
            this.queue.unshift(item);
            this._processNext();
          }
        }, delay);
      }
    }

    // Process next item
    this._processNext();
  }
}

module.exports = { DownloadQueue };
