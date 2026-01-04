// Bibliac Website - GitHub API Integration

const REPO_OWNER = 'yipihey';
const REPO_NAME = 'bibliac';
const GITHUB_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;

// DOM Elements
const downloadBtn = document.getElementById('download-btn');
const versionBadge = document.getElementById('version-badge');
const changelogList = document.getElementById('changelog-list');

// Fetch latest release and update download button
async function fetchLatestRelease() {
  try {
    const response = await fetch(`${GITHUB_API}/releases/latest`);

    if (!response.ok) {
      // No releases yet
      if (response.status === 404) {
        versionBadge.textContent = 'No releases yet';
        downloadBtn.href = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`;
        downloadBtn.innerHTML = `
          <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
          </svg>
          View Releases
        `;
        return;
      }
      throw new Error('Failed to fetch release');
    }

    const release = await response.json();

    // Update version badge
    versionBadge.textContent = `Version ${release.tag_name}`;

    // Find macOS DMG asset
    const dmgAsset = release.assets.find(a => a.name.endsWith('.dmg'));
    const zipAsset = release.assets.find(a => a.name.endsWith('.zip') && a.name.includes('darwin'));
    const asset = dmgAsset || zipAsset;

    if (asset) {
      downloadBtn.href = asset.browser_download_url;

      // Add download count if available
      const totalDownloads = release.assets.reduce((sum, a) => sum + a.download_count, 0);
      if (totalDownloads > 0) {
        versionBadge.textContent += ` • ${formatNumber(totalDownloads)} downloads`;
      }
    } else {
      // No macOS build, link to release page
      downloadBtn.href = release.html_url;
    }

  } catch (error) {
    console.error('Error fetching latest release:', error);
    versionBadge.textContent = 'Version info unavailable';
    downloadBtn.href = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`;
  }
}

// Fetch all releases for changelog
async function fetchChangelog() {
  try {
    const response = await fetch(`${GITHUB_API}/releases`);

    if (!response.ok) {
      if (response.status === 404) {
        changelogList.innerHTML = `
          <div class="release-item">
            <p style="text-align: center; color: var(--text-muted);">
              No releases published yet. Check back soon!
            </p>
          </div>
        `;
        return;
      }
      throw new Error('Failed to fetch releases');
    }

    const releases = await response.json();

    if (releases.length === 0) {
      changelogList.innerHTML = `
        <div class="release-item">
          <p style="text-align: center; color: var(--text-muted);">
            No releases published yet. Check back soon!
          </p>
        </div>
      `;
      return;
    }

    // Display up to 5 most recent releases
    const recentReleases = releases.slice(0, 5);

    changelogList.innerHTML = recentReleases.map(release => `
      <div class="release-item">
        <div class="release-header">
          <a href="${release.html_url}" target="_blank" class="release-version">${release.tag_name}</a>
          <span class="release-date">${formatDate(release.published_at)}</span>
        </div>
        <div class="release-body">
          ${formatReleaseBody(release.body)}
        </div>
      </div>
    `).join('');

  } catch (error) {
    console.error('Error fetching changelog:', error);
    changelogList.innerHTML = `
      <div class="release-item">
        <p style="text-align: center; color: var(--text-muted);">
          Unable to load changelog. <a href="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases" target="_blank">View on GitHub</a>
        </p>
      </div>
    `;
  }
}

// Format release body (basic markdown to HTML)
function formatReleaseBody(body) {
  if (!body) return '<p>No release notes.</p>';

  // Basic markdown conversion
  let html = body
    // Escape HTML
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Headers
    .replace(/^### (.+)$/gm, '<strong>$1</strong>')
    .replace(/^## (.+)$/gm, '<strong>$1</strong>')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Lists
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/^\* (.+)$/gm, '<li>$1</li>')
    // Wrap lists
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
    // Line breaks
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');

  // Remove the co-author line if present
  html = html.replace(/Co-Authored-By:.*$/gm, '');
  html = html.replace(/🤖 Generated with.*$/gm, '');

  return `<p>${html}</p>`;
}

// Format date
function formatDate(dateString) {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

// Format number with commas
function formatNumber(num) {
  return num.toLocaleString();
}

// Smooth scroll for anchor links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
  anchor.addEventListener('click', function(e) {
    const href = this.getAttribute('href');
    if (href === '#') return;

    e.preventDefault();
    const target = document.querySelector(href);
    if (target) {
      target.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      });
    }
  });
});

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  fetchLatestRelease();
  fetchChangelog();
});
