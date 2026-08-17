const { Plugin, PluginSettingTab, Setting, Modal, Notice, Menu, requestUrl, normalizePath } = require('obsidian');
const fs = require('fs');
const nodePath = require('path');

const DEFAULT_TEMPLATE = [
	'---',
	'英文名: {{english_name}}',
	'封面: {{cover}}',
	'类型: 游戏',
	'状态: {{status}}',
	'来源: Steam',
	'路径: {{path}}',
	'大小: {{size}}',
	'时长: {{playtime}}',
	'成就: {{achievements}}',
	'标签:',
	'steam_appid: {{appid}}',
	'---',
	'## 封面',
	'![{{name}}]({{cover}})',
	'## 备注',
	'',
	'## 成就',
	'<!-- steam-sync-achievements:start -->',
	'{{achievement_list}}',
	'<!-- steam-sync-achievements:end -->',
	''
].join('\n');

const ACH_START = '<!-- steam-sync-achievements:start -->';
const ACH_END = '<!-- steam-sync-achievements:end -->';

const DEFAULT_SETTINGS = {
	apiKey: '',
	steamId: '',
	folder: '资源库/游戏',
	indexFile: '资源库/游戏.md',
	steamLibraryPath: 'D:/Gamelib/SteamLibrary',
	steamGridDBApiKey: '',
	template: DEFAULT_TEMPLATE,
	showOnlyPlayed: true,
	writeAppId: true,
	syncAchievements: true,
	writeAchievementList: true,
	includeLockedAchievements: true,
	appidMap: {},
	platformAppidMap: {},
	psnAccessToken: '',
	psnRefreshToken: '',
	psnDataSource: 'gamelist',
	xboxAuthorization: '',
	xboxXuid: '',
	epicAccessToken: '',
	epicManifestPath: 'C:/ProgramData/Epic/EpicGamesLauncher/Data/Manifests'
};

function sanitizeFileName(name) {
	return String(name || '')
		.replace(/[\\/:*?"<>|]/g, ' ')
		.replace(/\s+/g, ' ')
		.replace(/[. ]+$/g, '')
		.trim() || 'Untitled';
}

function escapeRegExp(str) {
	return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function yamlString(value) {
	return JSON.stringify(String(value == null ? '' : value));
}

function yamlScalar(value) {
	const s = String(value == null ? '' : value);
	if (s === '') return '';
	if (/[:#{}[\],&*!|>'"%@`]/.test(s) || /^\s|\s$/.test(s) || /^(true|false|null|yes|no)$/i.test(s)) {
		return yamlString(s);
	}
	return s;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDateFromTimestamp(ts) {
	if (!ts) return '从未';
	const d = new Date(ts * 1000);
	const mm = String(d.getMonth() + 1).padStart(2, '0');
	const dd = String(d.getDate()).padStart(2, '0');
	return `${d.getFullYear()}-${mm}-${dd}`;
}

function formatUnlockTime(ts) {
	if (!ts) return '';
	const d = new Date(ts * 1000);
	const hh = String(d.getHours()).padStart(2, '0');
	const mm = String(d.getMinutes()).padStart(2, '0');
	return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

function escapeHtml(value) {
	return String(value == null ? '' : value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function formatPercent(value) {
	const n = Number(value);
	if (!Number.isFinite(n)) return '';
	const rounded = Math.round(n * 10) / 10;
	return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function parseIsoDateToTimestamp(value) {
	if (!value) return 0;
	const t = Date.parse(String(value));
	return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

function parseDurationToMinutes(value) {
	if (value == null || value === '') return 0;
	if (typeof value === 'number') {
		if (value <= 0) return 0;
		// 如果数值很大，先按秒换算成分钟
		return value > 10000 ? Math.round(value / 60) : Math.round(value);
	}
	const s = String(value).trim();
	if (/^\d+(\.\d+)?$/.test(s)) {
		const n = parseFloat(s);
		return n > 10000 ? Math.round(n / 60) : Math.round(n);
	}
	// ISO 8601 duration，例如 PT1H2M3S
	const iso = s.match(/PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?/i);
	if (iso) {
		const hours = Number(iso[1] || 0);
		const minutes = Number(iso[2] || 0);
		const seconds = Number(iso[3] || 0);
		if (hours || minutes || seconds) return Math.round(hours * 60 + minutes + seconds / 60);
	}
	// 类似 "1h 2m" / "2分钟" / "3小时"
	const hh = s.match(/(\d+(?:\.\d+)?)\s*(?:小时|hours?|hrs?|h)/i);
	const mm = s.match(/(\d+(?:\.\d+)?)\s*(?:分钟|mins?|minutes?|m)/i);
	if (hh || mm) {
		return Math.round((Number(hh && hh[1] || 0)) * 60 + Number(mm && mm[1] || 0));
	}
	return 0;
}

function firstDefined(...values) {
	for (const v of values) {
		if (v !== undefined && v !== null && v !== '') return v;
	}
	return '';
}

function formatPlaytime(minutes, available = true) {
	const mins = Number(minutes) || 0;
	if (!available) return '无数据';
	if (mins <= 0) return '未游玩';
	const hours = mins / 60;
	if (hours < 10 && !Number.isInteger(Number(hours.toFixed(1)))) {
		return `约 ${hours.toFixed(1)} 小时`;
	}
	return `约 ${Math.round(hours)} 小时`;
}

function formatSize(bytes) {
	const n = Number(bytes) || 0;
	if (n <= 0) return '';
	const gb = n / (1024 ** 3);
	if (gb >= 10) return `${Math.round(gb)} GB`;
	if (gb >= 1) return `${Math.round(gb * 10) / 10} GB`;
	if (gb >= 0.1) return `${gb.toFixed(1)} GB`;
	const mb = n / (1024 ** 2);
	return `${Math.round(mb * 10) / 10}MB`;
}

function toFileUrl(absPath) {
	const unix = String(absPath || '').replace(/\\/g, '/');
	const m = unix.match(/^([A-Za-z]:)\/(.*)$/);
	if (m) {
		return 'file:///' + m[1] + '/' + m[2].split('/').filter(Boolean).map(encodeURIComponent).join('/');
	}
	return 'file:///' + unix.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

function normalizeName(s) {
	return String(s || '')
		.toLowerCase()
		.normalize('NFKC')
		.replace(/[\u2122\u00ae\u00a9]/g, '')
		.replace(/&/g, ' and ')
		.replace(/[:：\-–—_'"‘’“”.,!?()（）[\]【】]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function namesMatch(a, b) {
	if (!a || !b) return false;
	const na = normalizeName(a);
	const nb = normalizeName(b);
	return na.length > 0 && na === nb;
}

function formatTrophySummaryNote(ach) {
	return `已解锁 **${ach.unlocked}/${ach.total}**。\n\n> 该平台奖杯明细接口不可用，仅同步完成度（常见于 PSV / PS3 等历史平台）。`;
}

function tableCell(value) {
	return String(value || '')
		.replace(/\s+/g, ' ')
		.replace(/\|/g, '\\|')
		.trim();
}

function formatAchievementList(result, includeLocked, showPercent = true) {
	if (!result || !result.available) {
		return '该游戏没有成就数据，或统计未公开。';
	}

	let items = includeLocked
		? result.items.slice()
		: result.items.filter((item) => item.unlocked);
	items.sort((a, b) => {
		if (a.unlocked !== b.unlocked) return a.unlocked ? -1 : 1;
		return (b.unlocktime || 0) - (a.unlocktime || 0);
	});

	const headerRow = showPercent
		? '| 图标 | 名字 | 说明 | 时间 | 所有玩家完成百分比 |'
		: '| 图标 | 名字 | 说明 | 时间 |';
	const sepRow = showPercent
		? '| :---: | --- | --- | --- | ---: |'
		: '| :---: | --- | --- | --- |';

	const lines = [
		`已解锁 **${result.unlocked}/${result.total}**。`,
		'',
		headerRow,
		sepRow
	];

	if (!items.length) {
		return `${lines[0]}\n\n${includeLocked ? '没有成就数据。' : '暂无已解锁成就。'}`;
	}

	for (const item of items) {
		let name = item.name || item.id || '未命名成就';
		if (!item.unlocked && item.hidden && !item.name) name = '隐藏成就';
		const desc = String(item.description || '').replace(/\s+/g, ' ').trim()
			|| (!item.unlocked && item.hidden ? '隐藏成就' : '');
		const icon = item.unlocked ? (item.icon || item.icongray) : (item.icongray || item.icon);
		const percent = showPercent ? formatPercent(item.percent) : '';
		const time = item.unlocked && item.unlocktime ? formatUnlockTime(item.unlocktime) : '未解锁';
		const img = icon
			? `<img src="${escapeHtml(icon)}" width="48" height="48" alt="${escapeHtml(name)}">`
			: '';
		const percentCell = showPercent ? ` | ${percent ? `${percent}%` : ''}` : '';
		lines.push(`| ${img} | ${tableCell(name)} | ${tableCell(desc)} | ${tableCell(time)}${percentCell} |`);
	}

	return lines.join('\n');
}

function parseAcf(content) {
	const pick = (key) => {
		const m = content.match(new RegExp(`"${escapeRegExp(key)}"\\s+"([^"]*)"`));
		return m ? m[1] : '';
	};
	return {
		appid: pick('appid'),
		name: pick('name'),
		installdir: pick('installdir'),
		sizeOnDisk: pick('SizeOnDisk'),
		stateFlags: pick('StateFlags')
	};
}

function sumTrophyCounts(obj) {
	if (!obj || typeof obj !== 'object') return 0;
	return ['bronze', 'silver', 'gold', 'platinum'].reduce((sum, k) => sum + (Number(obj[k]) || 0), 0);
}

function psnCategoryToPlatform(category) {
	const map = {
		'ps5_native_game': 'PS5',
		'ps5_crossgen_bundle': 'PS5',
		'ps5_ps4_bundle': 'PS5',
		'ps4_game': 'PS4',
		'ps4_crossgen_bundle': 'PS4',
		'ps3_game': 'PS3',
		'psvita_game': 'PSVITA',
		'psp_game': 'PSP',
		'pspc_game': 'PC',
		'psvr_game': 'PSVR'
	};
	return map[String(category || '').trim()] || '';
}

class SteamSyncPlugin extends Plugin {
	async onload() {
		await this.loadSettings();
		await this.importSteamGridDBKeyIfNeeded();

		this.addRibbonIcon('gamepad', '同步游戏数据', (evt) => this.openPlatformMenu(evt));
		this.addCommand({
			id: 'fetch-steam-games',
			name: '获取 Steam 游戏数据',
			callback: () => this.fetchAndProcess()
		});
		this.addCommand({
			id: 'sync-existing-steam-games',
			name: '同步已有 Steam 游戏时长与成就',
			callback: () => this.syncExistingOnly()
		});
		this.addCommand({
			id: 'fetch-psn-games',
			name: '获取 PSN 游戏数据',
			callback: () => this.fetchPsnAndProcess()
		});
		this.addCommand({
			id: 'fetch-xbox-games',
			name: '获取 Xbox 游戏数据',
			callback: () => this.fetchXboxAndProcess()
		});
		this.addCommand({
			id: 'fetch-epic-games',
			name: '获取 Epic 游戏数据',
			callback: () => this.fetchEpicAndProcess()
		});
		this.addSettingTab(new SteamSyncSettingTab(this.app, this));
	}

	onunload() {}

	openPlatformMenu(evt) {
		const menu = new Menu();
		menu.addItem((item) => item
			.setTitle('Steam')
			.setIcon('gamepad')
			.onClick(() => this.fetchAndProcess()));
		menu.addItem((item) => item
			.setTitle('PSN')
			.setIcon('gamepad')
			.onClick(() => this.fetchPsnAndProcess()));
		menu.addItem((item) => item
			.setTitle('Xbox')
			.setIcon('gamepad')
			.onClick(() => this.fetchXboxAndProcess()));
		menu.addItem((item) => item
			.setTitle('Epic')
			.setIcon('gamepad')
			.onClick(() => this.fetchEpicAndProcess()));
		menu.showAtMouseEvent(evt);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		if (!this.settings.appidMap || typeof this.settings.appidMap !== 'object') {
			this.settings.appidMap = {};
		}
		if (!this.settings.platformAppidMap || typeof this.settings.platformAppidMap !== 'object') {
			this.settings.platformAppidMap = {};
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async importSteamGridDBKeyIfNeeded() {
		if (this.settings.steamGridDBApiKey) return;
		const key = await this.detectSteamGridDBKey();
		if (key) {
			this.settings.steamGridDBApiKey = key;
			await this.saveSettings();
		}
	}

	async detectSteamGridDBKey() {
		try {
			const plugin = this.app.plugins?.getPlugin?.('steamgriddb-embedder');
			if (plugin?.settings?.steamGridDBApiKey) return plugin.settings.steamGridDBApiKey;
		} catch (e) {
			// ignore
		}
		try {
			const raw = await this.app.vault.adapter.read('.obsidian/plugins/steamgriddb-embedder/data.json');
			const json = JSON.parse(raw);
			if (json && json.steamGridDBApiKey) return json.steamGridDBApiKey;
		} catch (e) {
			// ignore
		}
		return '';
	}

	async fetchAndProcess() {
		if (!this.settings.apiKey || !this.settings.steamId) {
			new Notice('请先在设置中填写 Steam API Key 和 Steam ID');
			return;
		}

		const notice = new Notice('正在获取 Steam 游戏数据...', 0);
		try {
			const steamId = await this.resolveSteamId(this.settings.steamId);
			this.activeSteamId = steamId;
			const games = await this.fetchOwnedGames(steamId);
			const library = this.scanSteamLibrary();
			const existingMap = await this.matchExistingGames(games);

			let syncedCount = 0;
			const newGames = [];
			for (const game of games) {
				const file = existingMap.get(String(game.appid));
				if (file) {
					await this.syncGameToFile(game, file, steamId);
					syncedCount++;
					if (this.settings.syncAchievements) await sleep(150);
				} else {
					newGames.push(game);
				}
			}

			if (syncedCount > 0) await this.saveSettings();

			notice.hide();
			if (syncedCount > 0) {
				new Notice(`已同步 ${syncedCount} 个已有游戏的时长${this.settings.syncAchievements ? '与成就' : ''}`);
			}

			let candidates = newGames;
			if (this.settings.showOnlyPlayed) {
				candidates = candidates.filter((g) => (g.playtime_forever || 0) > 0);
			}
			candidates.sort((a, b) => (b.playtime_forever || 0) - (a.playtime_forever || 0));

			if (!candidates.length) {
				new Notice('没有新游戏需要创建（已有游戏已全部同步）');
				return;
			}

			new GameSelectModal(this, candidates, library, null).open();
		} catch (e) {
			notice.hide();
			console.error('[Steam Sync] 获取失败', e);
			new Notice(`获取 Steam 数据失败：${e.message || e}`);
		}
	}

	async syncExistingOnly() {
		if (!this.settings.apiKey || !this.settings.steamId) {
			new Notice('请先在设置中填写 Steam API Key 和 Steam ID');
			return;
		}

		const notice = new Notice('正在同步已有 Steam 游戏...', 0);
		try {
			const steamId = await this.resolveSteamId(this.settings.steamId);
			this.activeSteamId = steamId;
			const games = await this.fetchOwnedGames(steamId);
			const existingMap = await this.matchExistingGames(games);

			let count = 0;
			for (const game of games) {
				const file = existingMap.get(String(game.appid));
				if (file) {
					await this.syncGameToFile(game, file, steamId);
					count++;
					if (this.settings.syncAchievements) await sleep(150);
				}
			}
			if (count > 0) await this.saveSettings();

			notice.hide();
			new Notice(`已同步 ${count} 个已有游戏的时长${this.settings.syncAchievements ? '与成就' : ''}`);
		} catch (e) {
			notice.hide();
			console.error('[Steam Sync] 同步失败', e);
			new Notice(`同步失败：${e.message || e}`);
		}
	}

	getPlatformConfig(platform) {
		const configs = {
			psn: {
				label: 'PSN',
				appidKey: 'psn_appid',
				sourceLabel: 'PSN',
				hasListPlaytime: true,
				notice: '请先在设置中填写 PSN Access Token（推荐同时填写 Refresh Token）'
			},
			xbox: {
				label: 'Xbox',
				appidKey: 'xbox_appid',
				sourceLabel: 'Xbox',
				notice: '请先在设置中填写 Xbox XBL3.0 Authorization'
			},
			epic: {
				label: 'Epic',
				appidKey: 'epic_appid',
				sourceLabel: 'Epic',
				notice: '请先在设置中填写 Epic Access Token，或确认 Epic 本地清单路径可读'
			}
		};
		return configs[platform] || null;
	}

	hasPlatformAuth(platform) {
		if (platform === 'psn') {
			return !!(String(this.settings.psnAccessToken || '').trim());
		}
		if (platform === 'xbox') {
			return !!(String(this.settings.xboxAuthorization || '').trim());
		}
		if (platform === 'epic') {
			return true;
		}
		return false;
	}

	async fetchPsnAndProcess() {
		await this.fetchAndProcessForPlatform('psn');
	}

	async fetchXboxAndProcess() {
		await this.fetchAndProcessForPlatform('xbox');
	}

	async fetchEpicAndProcess() {
		await this.fetchAndProcessForPlatform('epic');
	}

	async fetchAndProcessForPlatform(platform) {
		const config = this.getPlatformConfig(platform);
		if (!config) throw new Error(`未知平台：${platform}`);
		if (!this.hasPlatformAuth(platform)) {
			new Notice(config.notice);
			return;
		}

		const notice = new Notice(`正在获取 ${config.label} 游戏数据...`, 0);
		try {
			const games = await this.fetchPlatformGames(platform);
			if (!Array.isArray(games) || games.length === 0) {
				notice.hide();
				new Notice(`${config.label} 没有获取到游戏数据，请检查授权、隐私设置或接口是否已变化`);
				return;
			}

			const library = platform === 'epic' ? this.scanEpicLibrary() : new Map();
			const existingMap = await this.matchExistingPlatformGames(platform, games);

			let syncedCount = 0;
			const newGames = [];
			for (const game of games) {
				const file = existingMap.get(String(game.id));
				if (file) {
					await this.syncPlatformGameToFile(platform, game, file);
					syncedCount++;
					if (platform === 'xbox' || platform === 'psn') await sleep(150);
				} else {
					newGames.push(game);
				}
			}

			if (syncedCount > 0) await this.saveSettings();

			notice.hide();
			if (syncedCount > 0) {
				new Notice(`已同步 ${syncedCount} 个已有 ${config.label} 游戏的时长`);
			}

			let candidates = newGames;
			if (this.settings.showOnlyPlayed && config.hasListPlaytime) {
				candidates = candidates.filter((g) => (g.playtime_forever || 0) > 0);
			}
			candidates.sort((a, b) => (b.playtime_forever || 0) - (a.playtime_forever || 0));

			if (!candidates.length) {
				new Notice(`没有新 ${config.label} 游戏需要创建（已有游戏已全部同步）`);
				return;
			}

			new GameSelectModal(this, candidates, library, platform).open();
		} catch (e) {
			notice.hide();
			console.error(`[Steam Sync] 获取 ${config.label} 数据失败`, e);
			new Notice(`获取 ${config.label} 数据失败：${e.message || e}`);
		}
	}

	async fetchPlatformGames(platform) {
		if (platform === 'psn') return this.fetchPsnGames();
		if (platform === 'xbox') return this.fetchXboxGames();
		if (platform === 'epic') return this.fetchEpicGames();
		throw new Error(`未知平台：${platform}`);
	}

	psnHeaders(token) {
		return {
			Authorization: `Bearer ${token}`,
			Accept: 'application/json',
			'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36',
			'Accept-Language': 'en-US,en;q=0.9',
			Country: 'US'
		};
	}

	isPsnTokenExpired(resp) {
		let json = resp && resp.json;
		if (!json) {
			try { json = JSON.parse(String(resp && resp.text || '')); } catch (e) { json = null; }
		}
		const err = json && json.error;
		return !!(err && (err.code === 1572996 || err.reason === 'expiredToken' || /expired jwt token/i.test(String(err.message || ''))));
	}

	async tryRefreshPsnToken() {
		const refreshToken = String(this.settings.psnRefreshToken || '').trim();
		if (!refreshToken) return '';
		try {
			const resp = await requestUrl({
				url: 'https://ca.account.sony.com/api/authz/v3/oauth/token',
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					Authorization: 'Basic MDk1MTUxNTktNzIzNy00MzcwLTliNDAtMzgwNmU2N2MwODkxOnVjUGprYTV0bnRCMktxc1A='
				},
				body: `grant_type=refresh_token&token_format=jwt&scope=${encodeURIComponent('psn:mobile.v2.core psn:clientapp')}&refresh_token=${encodeURIComponent(refreshToken)}`,
				throw: false
			});
			const json = resp.json || {};
			if (resp.status >= 200 && resp.status < 300 && json.access_token) {
				const newToken = String(json.access_token).trim();
				this.settings.psnAccessToken = newToken;
				if (json.refresh_token) {
					this.settings.psnRefreshToken = String(json.refresh_token).trim();
				}
				await this.saveSettings();
				return newToken;
			}
			console.warn('[Steam Sync] PSN 刷新令牌失效', resp.status, String(json.error_description || json.error || ''));
			return '';
		} catch (e) {
			console.warn('[Steam Sync] PSN 自动刷新异常', e.message || e);
			return '';
		}
	}

	async psnGet(url) {
		let token = String(this.settings.psnAccessToken || '').trim();
		let resp = await requestUrl({
			url,
			method: 'GET',
			headers: this.psnHeaders(token),
			throw: false
		});
		if (resp.status === 401 && this.isPsnTokenExpired(resp)) {
			const newToken = await this.tryRefreshPsnToken();
			if (newToken) {
				resp = await requestUrl({
					url,
					method: 'GET',
					headers: this.psnHeaders(newToken),
					throw: false
				});
			}
		}
		return resp;
	}

	async fetchPsnGames() {
		if (this.settings.psnDataSource === 'trophy') return this.fetchPsnGamesFromTrophy();
		return this.fetchPsnGamesFromGameList();
	}

	throwPsnError(resp, ctx) {
		const label = ctx ? `PSN ${ctx}` : 'PSN 接口';
		if (resp.status === 401) {
			const hasRefresh = !!(String(this.settings.psnRefreshToken || '').trim());
			throw new Error(hasRefresh
				? 'PSN 认证失败：Access Token 与 Refresh Token 均无效，请重新通过 psn-api 获取并填写'
				: 'PSN Access Token 无效或已过期（401），请在设置中填写 Refresh Token 以便自动刷新，或重新获取 Access Token');
		}
		if (resp.status === 403) throw new Error(`${label}请求被拒绝（403），可能需要检查 Token 权限或 PSN 隐私设置`);
		if (resp.status === 429) throw new Error(`${label}请求过于频繁（429），请稍后再试`);
		if (resp.status < 200 || resp.status >= 300) {
			const body = resp.text || '';
			console.error('[Steam Sync] PSN API HTTP', resp.status, body);
			throw new Error(`${label}返回 HTTP ${resp.status}：${String(body).slice(0, 300)}`);
		}
	}

	async psnGetJson(url, ctx) {
		const resp = await this.psnGet(url);
		this.throwPsnError(resp, ctx);
		return resp.json || {};
	}

	async psnTitleTrophyMap(npTitleIds) {
		const map = new Map();
		const unique = [...new Set(npTitleIds)].filter((id) => id && !/^psn-/i.test(String(id)));
		for (let i = 0; i < unique.length; i += 30) {
			await this.psnFetchTitleTrophyChunk(unique.slice(i, i + 30), map);
			await sleep(80);
		}
		return map;
	}

	async psnFetchTitleTrophyChunk(ids, map) {
		if (!ids.length) return;
		const url = `https://m.np.playstation.com/api/trophy/v1/users/me/titles/trophyTitles?npTitleIds=${ids.map((x) => encodeURIComponent(String(x))).join(',')}`;
		const resp = await this.psnGet(url);
		if (resp.status === 404) {
			if (ids.length === 1) {
				console.warn('[Steam Sync] PSN 奖杯映射未找到 titleId：' + ids[0]);
				return;
			}
			const mid = Math.ceil(ids.length / 2);
			await this.psnFetchTitleTrophyChunk(ids.slice(0, mid), map);
			await sleep(60);
			await this.psnFetchTitleTrophyChunk(ids.slice(mid), map);
			return;
		}
		this.throwPsnError(resp, '奖杯标题映射');
		const json = resp.json || {};
		for (const entry of Array.isArray(json.titles) ? json.titles : []) {
			for (const tt of Array.isArray(entry.trophyTitles) ? entry.trophyTitles : []) {
				if (entry.npTitleId && tt.npCommunicationId) map.set(String(entry.npTitleId), tt);
			}
		}
	}

	async fetchPsnGamesFromGameList() {
		if (!String(this.settings.psnAccessToken || '').trim()) throw new Error('请先在设置中填写 PSN Access Token');

		const allTitles = [];
		let offset = 0;
		const limit = 200;
		while (true) {
			const json = await this.psnGetJson(`https://m.np.playstation.com/api/gamelist/v2/users/me/titles?limit=${limit}&offset=${offset}`, '游戏列表');
			const titles = (json && Array.isArray(json.titles)) ? json.titles : [];
			allTitles.push(...titles);
			const nextOffset = json && json.nextOffset;
			if (nextOffset == null || titles.length === 0) break;
			offset = nextOffset;
			await sleep(80);
		}

		const idMap = this.settings.syncAchievements
			? await this.psnTitleTrophyMap(allTitles.map((t) => String(firstDefined(t.titleId, t.npTitleId, t.conceptId, t.id))).filter(Boolean))
			: new Map();

		return allTitles.map((t, idx) => {
			const cover = firstDefined(t.imageUrl, t.localizedImageUrl, t.conceptIconUrl, t.coverUrl, '');
			const name = firstDefined(t.name, t.localizedName, t.titleName, t.title, `PSN 游戏 ${idx + 1}`);
			const titleId = String(firstDefined(t.titleId, t.npTitleId, t.conceptId, t.id, `psn-${idx}`));
			const trophy = idMap.get(titleId);
			const defined = trophy ? sumTrophyCounts(trophy.definedTrophies) : 0;
			const earned = trophy ? sumTrophyCounts(trophy.earnedTrophies) : 0;
			const playDur = firstDefined(t.playDuration, t.playedDuration, t.totalPlayTime, '');
			return {
				id: titleId,
				npCommunicationId: trophy ? String(trophy.npCommunicationId || '') : '',
				name,
				psnPlatform: psnCategoryToPlatform(t.category),
				platform: 'PSN',
				source: 'PSN',
				playtime_forever: parseDurationToMinutes(playDur),
				playtime_available: playDur !== '',
				rtime_last_played: parseIsoDateToTimestamp(firstDefined(t.lastPlayedDateTime, t.lastPlayedDate, '')),
				cover,
				thumbnail: cover,
				achievements: defined > 0 ? `${earned}/${defined}` : '',
				trophyEarned: earned,
				trophyDefined: defined,
				trophyRate: trophy ? (Number(trophy.progress) || 0) : 0,
				raw: t
			};
		});
	}

	async fetchPsnGamesFromTrophy() {
		if (!String(this.settings.psnAccessToken || '').trim()) throw new Error('请先在设置中填写 PSN Access Token');

		const all = [];
		let offset = 0;
		const limit = 200;
		while (true) {
			const json = await this.psnGetJson(`https://m.np.playstation.com/api/trophy/v1/users/me/trophyTitles?limit=${limit}&offset=${offset}`, '奖杯游戏列表');
			const list = (json && Array.isArray(json.trophyTitles)) ? json.trophyTitles : [];
			all.push(...list);
			const nextOffset = json && json.nextOffset;
			if (nextOffset == null || list.length === 0) break;
			offset = nextOffset;
			await sleep(80);
		}

		return all.map((tt, idx) => {
			const defined = sumTrophyCounts(tt.definedTrophies);
			const earned = sumTrophyCounts(tt.earnedTrophies);
			const name = firstDefined(tt.trophyTitleName, tt.titleName, `PSN 游戏 ${idx + 1}`);
			const cover = firstDefined(tt.trophyTitleIconUrl, tt.defaultTrophyGroupIconUrl, '');
			return {
				id: String(tt.npCommunicationId || `psn-trophy-${idx}`),
				npCommunicationId: String(tt.npCommunicationId || ''),
				name,
				psnPlatform: String(tt.trophyTitlePlatform || ''),
				platform: 'PSN',
				source: 'PSN',
				playtime_forever: 0,
				playtime_available: false,
				rtime_last_played: 0,
				cover,
				thumbnail: cover,
				achievements: defined > 0 ? `${earned}/${defined}` : '',
				trophyEarned: earned,
				trophyDefined: defined,
				trophyRate: Number(tt.progress) || 0,
				raw: tt
			};
		});
	}

	async fetchPsnTrophyPage(url) {
		let resp;
		try {
			resp = await this.psnGet(url);
		} catch (e) {
			return { status: 0, json: null };
		}
		return { status: resp.status, json: resp.status >= 200 && resp.status < 300 && resp.json ? resp.json : null };
	}

	async fetchPsnTrophies(npCommunicationId, summary) {
		const fallbackEarned = summary && summary.earned ? Number(summary.earned) || 0 : 0;
		const fallbackDefined = summary && summary.defined ? Number(summary.defined) || 0 : 0;
		const hasSummary = fallbackDefined > 0;
		if (!npCommunicationId) {
			return hasSummary
				? { available: true, reason: 'summary', unlocked: fallbackEarned, total: fallbackDefined, items: [], trophies: { earned: fallbackEarned, defined: fallbackDefined } }
				: { available: false, reason: 'none', unlocked: 0, total: 0, items: [] };
		}
		try {
			const defs = await this.fetchPsnTrophyPage(`https://m.np.playstation.com/api/trophy/v1/npCommunicationIds/${encodeURIComponent(npCommunicationId)}/trophyGroups/all/trophies`);
			if (!(defs.status >= 200 && defs.status < 300) || !defs.json) {
				if (hasSummary) {
					console.warn('[Steam Sync] PSN Trophy API detail 不可用，仅使用汇总数据', npCommunicationId, 'HTTP', defs.status);
					return { available: true, reason: 'summary', unlocked: fallbackEarned, total: fallbackDefined, items: [], trophies: { earned: fallbackEarned, defined: fallbackDefined } };
				}
				if (defs.status === 404 || defs.status === 403) {
					console.warn('[Steam Sync] PSN game has no trophy data', npCommunicationId, 'HTTP', defs.status);
					return { available: false, reason: 'none', unlocked: 0, total: 0, items: [] };
				}
				console.error('[Steam Sync] PSN Trophy API error', npCommunicationId, 'HTTP', defs.status);
				return { available: false, reason: 'error', unlocked: 0, total: 0, items: [] };
			}

			const earned = await this.fetchPsnTrophyPage(`https://m.np.playstation.com/api/trophy/v1/users/me/npCommunicationIds/${encodeURIComponent(npCommunicationId)}/trophyGroups/all/trophies`);
			if (earned.status === 0 || (earned.status >= 500 && earned.status < 600)) {
				console.error('[Steam Sync] PSN Trophy API error (earned)', npCommunicationId, 'HTTP', earned.status);
				return { available: false, reason: 'error', unlocked: 0, total: 0, items: [] };
			}

			const defList = Array.isArray(defs.json.trophies) ? defs.json.trophies : [];
			const earnedList = earned.status >= 200 && earned.status < 300 && earned.json && Array.isArray(earned.json.trophies) ? earned.json.trophies : [];

			const earnedById = new Map();
			for (const e of earnedList) earnedById.set(String(e.trophyId), e);

			const items = defList.map((d) => {
				const e = earnedById.get(String(d.trophyId));
				return {
					id: String(d.trophyId),
					name: d.trophyName || '',
					description: d.trophyDetail || '',
					unlocked: !!(e && e.earned),
					unlocktime: parseIsoDateToTimestamp(e ? e.earnedDateTime : ''),
					icon: d.trophyIconUrl || '',
					icongray: '',
					hidden: !!d.trophyHidden,
					percent: e ? (Number(e.trophyEarnedRate) || 0) : 0
				};
			});

			return {
				available: items.length > 0,
				reason: items.length > 0 ? 'ok' : 'none',
				unlocked: items.filter((i) => i.unlocked).length,
				total: items.length,
				items
			};
		} catch (e) {
			console.error('[Steam Sync] PSN Trophy API error', npCommunicationId, e.message || e);
			return { available: false, reason: 'error', unlocked: 0, total: 0, items: [] };
		}
	}

getXboxAuthHeaders() {
		let auth = String(this.settings.xboxAuthorization || '').trim();
		if (!auth) throw new Error('请先在设置中填写 Xbox XBL3.0 Authorization');
		if (!auth.startsWith('XBL3.0')) auth = `XBL3.0 ${auth}`;
		if (!auth.includes(';')) {
			throw new Error('Xbox Authorization 不完整：应为 XBL3.0 x=你的令牌;你的用户哈希(uhs)。请从浏览器 F12 里完整复制整行 Authorization 值');
		}
		return {
			Authorization: auth
		};
	}

	async getXboxXuid(baseHeaders) {
		let xuid = String(this.settings.xboxXuid || '').trim();
		if (!xuid) {
			xuid = await this.fetchXboxXuid(baseHeaders);
			this.settings.xboxXuid = xuid;
			await this.saveSettings();
		}
		return xuid;
	}

	async fetchXboxGames() {
		const baseHeaders = this.getXboxAuthHeaders();
		const xuid = await this.getXboxXuid(baseHeaders);

		const url = `https://titlehub.xboxlive.com/users/xuid(${encodeURIComponent(xuid)})/titles/titlehistory/decoration/scid,image,achievement?maxItems=1000`;
		let resp;
		try {
			resp = await requestUrl({
				url,
				method: 'GET',
				headers: {
					...baseHeaders,
					'x-xbl-contract-version': '2',
					Accept: 'application/json'
				}
			});
		} catch (e) {
			throw new Error(`Xbox titlehub 请求失败（${url}）：${e.message || e}${e.status ? `，status=${e.status}` : ''}`);
		}
		if (resp.status < 200 || resp.status >= 300) {
			throw new Error(`Xbox titlehub API 返回 HTTP ${resp.status}：${String(resp.text || '').slice(0, 300)}`);
		}
		const json = resp.json;
		const titles = (json && Array.isArray(json.titles)) ? json.titles : [];
		const games = titles.map((t, idx) => {
			const history = t.titleHistory || {};
			const images = Array.isArray(t.images) ? t.images : [];
			const cover = firstDefined(
				images.find((img) => img.type === 'BoxArt' || img.type === 'Poster'),
				images[0],
				null
			);
			const coverUrl = cover ? (cover.url || cover.imageUrl || '') : '';
			const ach = t.achievement || {};
			const achievements = (ach.currentAchievements != null && ach.totalAchievements != null)
				? `${ach.currentAchievements}/${ach.totalAchievements}`
				: '';
			return {
				id: String(firstDefined(t.titleId, t.pfn, `xbox-${idx}`)),
				scid: String(firstDefined(t.serviceConfigId, t.scid, '')),
				name: firstDefined(t.name, t.titleName, `Xbox 游戏 ${idx + 1}`),
				platform: 'Xbox',
				source: 'Xbox',
				playtime_forever: 0,
				rtime_last_played: parseIsoDateToTimestamp(firstDefined(history.lastTimePlayed, t.lastTimePlayed, '')),
				cover: coverUrl,
				thumbnail: coverUrl,
				achievements,
				raw: t
			};
		});

		// titlehub 不返回时长，逐游戏从 userstats 补取
		for (let i = 0; i < games.length; i++) {
			const g = games[i];
			if (g.scid) g.playtime_forever = await this.fetchXboxMinutesPlayed(xuid, g.scid);
			if (i < games.length - 1) await sleep(80);
		}
		return games;
	}

	async fetchXboxXuid(baseHeaders) {
		const url = 'https://profile.xboxlive.com/users/me/profile/settings?settings=Gamertag';
		let lastErr = null;
		for (const contractVersion of ['3.0', '2']) {
			try {
				const resp = await requestUrl({
					url,
					method: 'GET',
					headers: {
						...baseHeaders,
						'x-xbl-contract-version': contractVersion,
						Accept: 'application/json'
					}
				});
				if (resp.status < 200 || resp.status >= 300) {
					lastErr = new Error(`Xbox profile API 返回 HTTP ${resp.status}（contract=${contractVersion}）：${String(resp.text || '').slice(0, 300)}`);
					continue;
				}
				const json = resp.json;
				const xuid = json && json.profileUsers && json.profileUsers[0] && json.profileUsers[0].id;
				if (xuid) return String(xuid);
				lastErr = new Error('profile 响应中没有 xuid');
			} catch (e) {
				lastErr = new Error(`Xbox profile 请求失败（${url}，contract=${contractVersion}）：${e.message || e}${e.status ? `，status=${e.status}` : ''}`);
			}
		}
		throw new Error((lastErr && lastErr.message) || `无法获取 Xbox xuid，请在设置中手动填写 xuid`);
	}

	async fetchXboxAchievements(xuid, titleId, scid) {
		const empty = { available: false, reason: 'none', unlocked: 0, total: 0, items: [] };
		if (!xuid || (!titleId && !scid)) return empty;

		const baseHeaders = this.getXboxAuthHeaders();

		const parseItems = (list) => list.map((a) => {
			const unlocked = String(a.progressState || '').toLowerCase() === 'achieved';
			const media = Array.isArray(a.mediaAssets) ? a.mediaAssets : [];
			const iconAsset = media.find((m) => m && /icon|achievementimage|image/i.test(m.name || '')) || media[0];
			return {
				id: String(a.id || ''),
				name: a.name || '',
				description: a.description || '',
				unlocked,
				unlocktime: parseIsoDateToTimestamp(a.timeUnlocked || (a.progression && a.progression.timeUnlocked) || ''),
				icon: (iconAsset && (iconAsset.url || iconAsset.uri)) || '',
				icongray: '',
				hidden: !!a.isSecret,
				percent: 0
			};
		});

		const fetchList = async (url) => {
			try {
				const resp = await requestUrl({
					url,
					method: 'GET',
					headers: {
						...baseHeaders,
						'x-xbl-contract-version': '2',
						Accept: 'application/json'
					}
				});
				if (resp.status < 200 || resp.status >= 300) {
					console.warn('[Steam Sync] Xbox 成就接口返回异常', resp.status, String(resp.text || '').slice(0, 300));
					return [];
				}
				const json = resp.json;
				return (json && Array.isArray(json.achievements)) ? json.achievements : [];
			} catch (e) {
				console.warn('[Steam Sync] Xbox 成就接口请求失败', url, e);
				return [];
			}
		};

		let items = [];

		// 1) 用户成就接口：按十进制 titleId 查询
		if (titleId) {
			items = parseItems(await fetchList(`https://achievements.xboxlive.com/users/xuid(${encodeURIComponent(xuid)})/achievements?titleId=${encodeURIComponent(titleId)}&maxItems=1000`));
		}

		// 2) 标题成就定义接口：全量列表（含未解锁）
		if (!items.length && titleId) {
			items = parseItems(await fetchList(`https://achievements.xboxlive.com/titles/${encodeURIComponent(titleId)}/achievements?maxItems=1000`));
		}

		return {
			available: items.length > 0,
			reason: items.length > 0 ? 'ok' : 'none',
			unlocked: items.filter((item) => item.unlocked).length,
			total: items.length,
			items
		};
	}

	async fetchXboxMinutesPlayed(xuid, scid) {
		if (!xuid || !scid) return 0;
		try {
			const url = `https://userstats.xboxlive.com/users/xuid(${encodeURIComponent(xuid)})/scids/${encodeURIComponent(scid)}/stats/MinutesPlayed`;
			const baseHeaders = this.getXboxAuthHeaders();
			const resp = await requestUrl({
				url,
				method: 'GET',
				headers: {
					...baseHeaders,
					'x-xbl-contract-version': '2',
					Accept: 'application/json'
				}
			});
			if (resp.status < 200 || resp.status >= 300) return 0;
			const json = resp.json;
			const collections = json && (json.statlistscollection || json.statListsCollection || []);
			const stats = Array.isArray(collections) && collections[0] ? collections[0].stats : null;
			const value = Array.isArray(stats) && stats[0] ? stats[0].value : 0;
			return Math.max(0, Number(value) || 0);
		} catch (e) {
			console.warn('[Steam Sync] Xbox 时长获取失败', scid, e);
			return 0;
		}
	}

	async fetchEpicGames() {
		const token = String(this.settings.epicAccessToken || '').trim();
		if (!token) {
			// 没有 token 时退回本地清单，只读取已安装游戏
			return this.scanEpicLibraryGames();
		}

		const accountId = await this.fetchEpicAccountId(token);
		const url = `https://library-service.live.use1a.on.epicgames.com/library/api/public/items?includeMetadata=true&accountId=${encodeURIComponent(accountId)}`;
		const resp = await requestUrl({
			url,
			method: 'GET',
			headers: {
				Authorization: `Bearer ${token}`
			}
		});
		if (resp.status < 200 || resp.status >= 300) {
			throw new Error(`Epic API 返回 HTTP ${resp.status}`);
		}
		const json = resp.json;
		const records = (json && Array.isArray(json.records)) ? json.records : (Array.isArray(json.items) ? json.items : []);
		return records.map((r, idx) => {
			const cover = firstDefined(
				r.metadata && r.metadata.background,
				r.metadata && r.metadata.logo,
				r.imageUrl,
				''
			);
			return {
				id: String(firstDefined(r.catalogItemId, r.mainGameItem, r.offerId, `epic-${idx}`)),
				name: firstDefined(r.appName, r.title, r.itemName, r.name, `Epic 游戏 ${idx + 1}`),
				platform: 'Epic',
				source: 'Epic',
				playtime_forever: parseDurationToMinutes(firstDefined(r.playtime, r.minutesPlayed, r.totalPlayTime, 0)),
				rtime_last_played: parseIsoDateToTimestamp(firstDefined(r.lastPlayedDate, r.lastPlayedDateTime, r.lastModifiedDate, '')),
				cover,
				thumbnail: cover,
				raw: r
			};
		});
	}

	async fetchEpicAccountId(token) {
		const url = 'https://account-public-service-prod03.ol.epicgames.com/account/api/public/account';
		const resp = await requestUrl({
			url,
			method: 'GET',
			headers: {
				Authorization: `Bearer ${token}`
			}
		});
		if (resp.status < 200 || resp.status >= 300) {
			throw new Error(`Epic 账号接口返回 HTTP ${resp.status}`);
		}
		const json = resp.json;
		const accountId = json && (json.id || json.accountId);
		if (accountId) return String(accountId);
		throw new Error('无法获取 Epic accountId，请检查 Access Token 是否有效');
	}

	scanEpicLibrary() {
		const map = new Map();
		const dir = String(this.settings.epicManifestPath || 'C:/ProgramData/Epic/EpicGamesLauncher/Data/Manifests').trim();
		let files = [];
		try {
			files = fs.readdirSync(dir).filter((name) => name.endsWith('.item'));
		} catch (e) {
			return map;
		}
		for (const name of files) {
			try {
				const raw = fs.readFileSync(nodePath.join(dir, name), 'utf8');
				const item = JSON.parse(raw);
				const id = firstDefined(item.CatalogItemId, item.MainGameItem, item.AppName, '');
				if (!id) continue;
				map.set(String(id), {
					installPath: item.InstallLocation || '',
					sizeOnDisk: Number(item.InstallSize) || 0,
					installed: true
				});
			} catch (e) {
				console.warn('[Steam Sync] 解析 Epic 清单失败', name, e);
			}
		}
		return map;
	}

	scanEpicLibraryGames() {
		const map = this.scanEpicLibrary();
		if (!map.size) {
			throw new Error('未填写 Epic Access Token，且无法读取 Epic 本地清单目录：' + String(this.settings.epicManifestPath || '').trim());
		}
		const games = [];
		for (const [id, info] of map.entries()) {
			games.push({
				id,
				name: nodePath.basename(String(info.installPath || '')) || id,
				platform: 'Epic',
				source: 'Epic',
				playtime_forever: 0,
				rtime_last_played: 0,
				cover: '',
				thumbnail: '',
				raw: info
			});
		}
		return games;
	}

	async matchExistingPlatformGames(platform, games) {
		const config = this.getPlatformConfig(platform);
		const map = new Map();
		const files = this.getGameNotes();
		const usedFiles = new Set();

		for (const file of files) {
			const fm = this.getFrontmatter(file);
			const appid = fm[config.appidKey];
			if (appid && String(appid).trim()) {
				const key = String(appid).trim();
				if (!map.has(key)) {
					map.set(key, file);
					usedFiles.add(file.path);
					this.settings.platformAppidMap[`${platform}:${key}`] = file.path;
				}
			}
		}

		const unmatchedGames = games.filter((g) => !map.has(String(g.id)));
		for (const file of files) {
			if (usedFiles.has(file.path)) continue;
			const fm = this.getFrontmatter(file);
			const english = fm['英文名'] || fm.englishTitle || fm.title || '';
			const title = file.basename;
			const game = unmatchedGames.find((g) => namesMatch(g.name, english) || namesMatch(g.name, title));
			if (game) {
				const key = String(game.id);
				map.set(key, file);
				usedFiles.add(file.path);
				this.settings.platformAppidMap[`${platform}:${key}`] = file.path;
				unmatchedGames.splice(unmatchedGames.indexOf(game), 1);
			}
		}
		return map;
	}

	getFrontmatter(file) {
		const cache = this.app.metadataCache.getFileCache(file);
		return (cache && cache.frontmatter) || {};
	}

	async syncPlatformGameToFile(platform, game, file, ach) {
		const config = this.getPlatformConfig(platform);
		const updates = {
			时长: formatPlaytime(game.playtime_forever || 0, game.playtime_available !== false)
		};

		let showPercent = false;
		if (platform === 'xbox') {
			const xuid = await this.getXboxXuid(this.getXboxAuthHeaders());
			if (this.settings.syncAchievements && !ach) {
				ach = await this.fetchXboxAchievements(xuid, game.id, game.scid);
			}
		} else if (platform === 'psn') {
			if (this.settings.syncAchievements && !ach) {
				ach = await this.fetchPsnTrophies(game.npCommunicationId, { earned: game.trophyEarned, defined: game.trophyDefined });
			}
			showPercent = true;
		}

		if (ach && ach.available) {
			updates.成就 = `${ach.unlocked}/${ach.total}`;
		} else if (ach && ach.reason === 'error') {
			// API 请求失败：不覆盖已有成就数据，避免把原有 Trophy 清空
			console.warn('[Steam Sync] PSN 奖杯获取失败，保留已有成就数据', game.name);
		} else if (ach && ach.reason === 'none') {
			updates.成就 = game.achievements || '无';
		} else if (game.achievements) {
			updates.成就 = game.achievements;
		}

		updates[config.appidKey] = game.id;
		await this.updateFrontmatter(file, updates);

		if (this.settings.writeAchievementList && ach && ach.available) {
			if (ach.reason === 'ok') {
				await this.upsertAchievementSection(
					file,
					formatAchievementList(ach, this.settings.includeLockedAchievements, showPercent)
				);
			} else if (ach.reason === 'summary') {
				await this.upsertAchievementSection(file, formatTrophySummaryNote(ach));
			}
		}

		this.settings.platformAppidMap[`${platform}:${String(game.id)}`] = file.path;
	}

	async buildPlatformTemplateData(platform, game, library, ach) {
		const local = library && game.id ? library.get(String(game.id)) : null;
		const installed = !!(local && local.installed);
		const absPath = installed ? local.installPath : '';

		let minutes = game.playtime_forever || 0;
		let achievements = game.achievements || '';
		let achievement_list = '';
		if (platform === 'xbox') {
			const xuid = await this.getXboxXuid(this.getXboxAuthHeaders());
			if (this.settings.syncAchievements) {
				const res = ach || await this.fetchXboxAchievements(xuid, game.id, game.scid);
				achievements = res.available ? `${res.unlocked}/${res.total}` : (game.achievements || '无');
				if (this.settings.writeAchievementList && res.available) {
					achievement_list = formatAchievementList(res, this.settings.includeLockedAchievements, false);
				}
			}
		} else if (platform === 'psn') {
			if (this.settings.syncAchievements) {
				const res = ach || await this.fetchPsnTrophies(game.npCommunicationId, { earned: game.trophyEarned, defined: game.trophyDefined });
				achievements = res.available ? `${res.unlocked}/${res.total}` : (game.achievements || '无');
				if (this.settings.writeAchievementList) {
					if (res.reason === 'ok') {
						achievement_list = formatAchievementList(res, this.settings.includeLockedAchievements, true);
					} else if (res.reason === 'summary') {
						achievement_list = formatTrophySummaryNote(res);
					}
				}
			}
		}

		return {
			name: game.name,
			english_name: yamlScalar(game.name),
			appid: game.id,
			playtime: formatPlaytime(minutes, game.playtime_available !== false),
			playtime_hours: Number((minutes / 60).toFixed(1)),
			playtime_minutes: minutes,
			last_played: formatDateFromTimestamp(game.rtime_last_played),
			cover: game.cover || '',
			status: installed ? '已下载' : '未下载',
			source: game.source,
			path: absPath ? yamlString(toFileUrl(absPath)) : '',
			size: installed ? formatSize(local.sizeOnDisk) : '',
			achievements,
			achievement_list,
			date: new Date().toISOString().slice(0, 10)
		};
	}

	renderPlatformTemplate(platform, template, data) {
		const config = this.getPlatformConfig(platform);
		let t = template || DEFAULT_TEMPLATE;
		if (platform !== 'steam') {
			t = t.replace(/来源:\s*Steam/g, `来源: ${config.sourceLabel}`);
			t = t.replace(/steam_appid:\s*\{\{appid\}\}/g, `${config.appidKey}: {{appid}}`);
		}
		return this.renderTemplate(t, data);
	}


	async resolveSteamId(input) {
		const trimmed = String(input || '').trim();
		if (!trimmed) throw new Error('Steam ID 为空');

		const profilesMatch = trimmed.match(/profiles\/(\d{17})/i);
		if (profilesMatch) return profilesMatch[1];
		if (/^\d{17}$/.test(trimmed)) return trimmed;

		const idMatch = trimmed.match(/id\/([^/?#]+)/i);
		const vanity = idMatch ? idMatch[1] : trimmed;
		const url = `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/?key=${encodeURIComponent(this.settings.apiKey)}&vanityurl=${encodeURIComponent(vanity)}&format=json`;
		const resp = await requestUrl({ url, method: 'GET' });
		const json = resp.json;
		if (json && json.response && json.response.success === 1) {
			return json.response.steamid;
		}
		throw new Error((json && json.response && json.response.message) || `无法解析 Steam ID：${trimmed}`);
	}

	async fetchOwnedGames(steamId) {
		const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${encodeURIComponent(this.settings.apiKey)}&steamid=${encodeURIComponent(steamId)}&include_appinfo=true&include_played_free_games=true&format=json`;
		const resp = await requestUrl({ url, method: 'GET' });
		const json = resp.json;
		if (!json || !json.response || !Array.isArray(json.response.games)) {
			throw new Error('Steam API 返回数据异常，请检查 API Key、Steam ID，以及 Steam 账号的游戏详情是否公开');
		}
		return json.response.games || [];
	}

	async fetchAppDetails(appid, retries = 2) {
		try {
			const url = `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(appid)}&l=schinese`;
			const resp = await requestUrl({ url, method: 'GET' });
			if (resp.status === 429 && retries > 0) {
				await sleep(1200);
				return this.fetchAppDetails(appid, retries - 1);
			}
			if (resp.status < 200 || resp.status >= 300) return null;
			const json = resp.json;
			const entry = json && json[String(appid)];
			if (entry && entry.success === true && entry.data) return entry.data;
		} catch (e) {
			console.warn(`[Steam Sync] 获取 App ${appid} 详情失败`, e);
			if (retries > 0) {
				await sleep(800);
				return this.fetchAppDetails(appid, retries - 1);
			}
		}
		return null;
	}

	async fetchCover(appid, fallbackUrl) {
		const key = this.settings.steamGridDBApiKey || await this.detectSteamGridDBKey();
		if (key) {
			try {
				const url = `https://www.steamgriddb.com/api/v2/grids/steam/${encodeURIComponent(appid)}?dimensions=600x900&nsfw=false&humor=false`;
				const resp = await requestUrl({
					url,
					method: 'GET',
					headers: {
						Authorization: `Bearer ${key}`
					}
				});
				const json = resp.json;
				if (json && json.success && Array.isArray(json.data) && json.data.length) {
					return json.data[0].url || fallbackUrl;
				}
			} catch (e) {
				console.warn('[Steam Sync] SteamGridDB 封面获取失败，改用 Steam 封面', e);
			}
		}
		return fallbackUrl;
	}

	async fetchAchievements(steamId, appid, game) {
		const empty = { available: false, reason: 'none', unlocked: 0, total: 0, items: [] };
		if (!steamId || !appid) return empty;
		if (game && game.has_community_visible_stats === false) return empty;

		try {
			const url = `https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key=${encodeURIComponent(this.settings.apiKey)}&steamid=${encodeURIComponent(steamId)}&appid=${encodeURIComponent(appid)}&l=schinese`;
			const resp = await requestUrl({ url, method: 'GET' });
			const stats = resp.json && resp.json.playerstats;
			if (!stats || stats.success === false) {
				const err = String((stats && stats.error) || '');
				if (/not public|private/i.test(err)) return { ...empty, reason: 'private' };
				return empty;
			}

			const list = Array.isArray(stats.achievements) ? stats.achievements : [];
			const items = list.map((a) => ({
				id: a.apiname,
				name: a.name || '',
				description: a.description || '',
				unlocked: Number(a.achieved) === 1,
				unlocktime: Number(a.unlocktime) || 0,
				icon: '',
				icongray: '',
				hidden: false,
				percent: 0
			}));

			if (this.settings.writeAchievementList && items.length) {
				const [schema, percents] = await Promise.all([
					this.fetchAchievementSchema(appid),
					this.fetchAchievementPercents(appid)
				]);
				for (const item of items) {
					const extra = schema.get(item.id);
					if (extra) {
						item.name = item.name || extra.displayName;
						item.description = item.description || extra.description;
						item.icon = extra.icon;
						item.icongray = extra.icongray;
						item.hidden = extra.hidden;
					}
					if (percents.has(item.id)) item.percent = percents.get(item.id);
				}
			}

			return {
				available: true,
				reason: 'ok',
				unlocked: items.filter((item) => item.unlocked).length,
				total: items.length,
				items
			};
		} catch (e) {
			console.warn('[Steam Sync] 成就获取失败', appid, e);
			return { ...empty, reason: 'error' };
		}
	}

	async fetchAchievementSchema(appid) {
		const map = new Map();
		try {
			const url = `https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=${encodeURIComponent(this.settings.apiKey)}&appid=${encodeURIComponent(appid)}&l=schinese`;
			const resp = await requestUrl({ url, method: 'GET' });
			const achs = resp.json && resp.json.game && resp.json.game.availableGameStats
				? resp.json.game.availableGameStats.achievements
				: null;
			if (!Array.isArray(achs)) return map;
			for (const a of achs) {
				map.set(a.name, {
					displayName: a.displayName || '',
					description: a.description || '',
					icon: a.icon || '',
					icongray: a.icongray || '',
					hidden: Number(a.hidden) === 1
				});
			}
		} catch (e) {
			console.warn('[Steam Sync] 成就 schema 失败', appid, e);
		}
		return map;
	}

	async fetchAchievementPercents(appid) {
		const map = new Map();
		try {
			const url = `https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${encodeURIComponent(appid)}`;
			const resp = await requestUrl({ url, method: 'GET' });
			const achs = resp.json && resp.json.achievementpercentages
				? resp.json.achievementpercentages.achievements
				: null;
			if (!Array.isArray(achs)) return map;
			for (const a of achs) {
				if (a && a.name) map.set(a.name, Number(a.percent) || 0);
			}
		} catch (e) {
			console.warn('[Steam Sync] 成就稀有度获取失败', appid, e);
		}
		return map;
	}

	scanSteamLibrary() {
		const map = new Map();
		const roots = this.collectSteamLibraryRoots();
		for (const root of roots) {
			const steamapps = nodePath.join(root, 'steamapps');
			let files = [];
			try {
				files = fs.readdirSync(steamapps);
			} catch (e) {
				continue;
			}
			for (const name of files) {
				if (!/^appmanifest_\d+\.acf$/i.test(name)) continue;
				try {
					const content = fs.readFileSync(nodePath.join(steamapps, name), 'utf8');
					const acf = parseAcf(content);
					if (!acf.appid || !acf.installdir) continue;
					const installPath = nodePath.join(steamapps, 'common', acf.installdir);
					map.set(String(acf.appid), {
						installPath,
						sizeOnDisk: Number(acf.sizeOnDisk) || 0,
						installed: String(acf.stateFlags || '') === '4' || fs.existsSync(installPath)
					});
				} catch (e) {
					console.warn('[Steam Sync] 解析 Steam 清单失败', name, e);
				}
			}
		}
		return map;
	}

	collectSteamLibraryRoots() {
		const roots = [];
		const add = (p) => {
			if (!p) return;
			const normalized = nodePath.resolve(String(p).replace(/[\\/]+$/, ''));
			if (!roots.includes(normalized) && fs.existsSync(normalized)) roots.push(normalized);
		};

		add(this.settings.steamLibraryPath);
		add('D:/Gamelib/SteamLibrary');
		add('C:/Program Files (x86)/Steam');

		for (const root of [...roots]) {
			const vdfCandidates = [
				nodePath.join(root, 'steamapps', 'libraryfolders.vdf'),
				nodePath.join(root, 'libraryfolders.vdf')
			];
			for (const vdf of vdfCandidates) {
				if (!fs.existsSync(vdf)) continue;
				try {
					const text = fs.readFileSync(vdf, 'utf8');
					const matches = text.matchAll(/"path"\s+"([^"]+)"/g);
					for (const m of matches) add(m[1].replace(/\\\\/g, '\\'));
				} catch (e) {
					// ignore
				}
			}
		}
		return roots;
	}

	async matchExistingGames(games) {
		const map = new Map();
		const files = this.getGameNotes();
		const usedFiles = new Set();

		for (const file of files) {
			const mappedAppid = this.appidFromMap(file);
			const fmAppid = this.getAppidFromCache(file);
			const appid = fmAppid || mappedAppid;
			if (appid && !map.has(appid)) {
				map.set(appid, file);
				usedFiles.add(file.path);
				this.settings.appidMap[appid] = file.path;
			}
		}

		const unmatchedGames = games.filter((g) => !map.has(String(g.appid)));
		for (const file of files) {
			if (usedFiles.has(file.path)) continue;
			const cache = this.app.metadataCache.getFileCache(file);
			const fm = (cache && cache.frontmatter) || {};
			const english = fm['英文名'] || fm.englishTitle || fm.title || '';
			const title = file.basename;
			const game = unmatchedGames.find((g) => namesMatch(g.name, english) || namesMatch(g.name, title));
			if (game) {
				const appid = String(game.appid);
				map.set(appid, file);
				usedFiles.add(file.path);
				this.settings.appidMap[appid] = file.path;
				unmatchedGames.splice(unmatchedGames.indexOf(game), 1);
			}
		}

		return map;
	}

	getGameNotes() {
		const folder = normalizePath(String(this.settings.folder || '').trim());
		const indexFile = normalizePath(String(this.settings.indexFile || '').trim());
		return this.app.vault.getMarkdownFiles().filter((file) => {
			if (indexFile && file.path === indexFile) return false;
			if (file.path.startsWith('Media DB/')) return false;
			if (folder && file.path.startsWith(folder + '/')) return true;
			const cache = this.app.metadataCache.getFileCache(file);
			const fm = cache && cache.frontmatter;
			return !!(fm && fm['类型'] === '游戏');
		});
	}

	appidFromMap(file) {
		const map = this.settings.appidMap || {};
		for (const [appid, path] of Object.entries(map)) {
			if (path === file.path) return String(appid);
		}
		return null;
	}

	getAppidFromCache(file) {
		const cache = this.app.metadataCache.getFileCache(file);
		const fm = cache && cache.frontmatter;
		if (!fm) return null;
		const appid = fm.steam_appid != null ? fm.steam_appid : (fm.appid != null ? fm.appid : fm.steamappid);
		if (appid == null || String(appid).trim() === '') return null;
		return String(appid).trim();
	}

	async syncGameToFile(game, file, steamId, ach) {
		const sid = steamId || this.activeSteamId;
		const updates = {
			时长: formatPlaytime(game.playtime_forever || 0)
		};
		if (this.settings.writeAppId) {
			updates.steam_appid = game.appid;
		}

		if (this.settings.syncAchievements && sid && !ach) {
			ach = await this.fetchAchievements(sid, game.appid, game);
		}
		if (ach && ach.available) {
			updates.成就 = `${ach.unlocked}/${ach.total}`;
		} else if (ach && ach.reason !== 'error' && ach.reason !== 'private') {
			updates.成就 = '无';
		}

		await this.updateFrontmatter(file, updates);
		if (this.settings.writeAchievementList && ach && ach.reason !== 'error' && ach.reason !== 'private') {
			await this.upsertAchievementSection(
				file,
				formatAchievementList(ach, this.settings.includeLockedAchievements)
			);
		}
		this.settings.appidMap[String(game.appid)] = file.path;
	}

	async upsertAchievementSection(file, markdown) {
		const inner = `${ACH_START}\n${markdown}\n${ACH_END}`;
		const block = `## 成就\n\n${inner}\n`;
		await this.app.vault.process(file, (content) => {
			if (content.includes(ACH_START) && content.includes(ACH_END)) {
				return content.replace(
					new RegExp(`${escapeRegExp(ACH_START)}[\\s\\S]*?${escapeRegExp(ACH_END)}`),
					inner
				);
			}
			if (/```steam-achievements[\s\S]*?```/.test(content)) {
				return content.replace(
					/(?:## 成就[^\n]*\n+)?```steam-achievements[\s\S]*?```/,
					block.trimEnd()
				);
			}
			const headingRe = /(^|\n)## 成就[^\n]*\n[\s\S]*?(?=\n## |\n?$)/;
			if (headingRe.test(content)) {
				return content.replace(headingRe, `$1${block}`);
			}
			return `${content.replace(/\s*$/, '')}\n\n${block}`;
		});
	}

	async updateFrontmatter(file, updates) {
		if (this.app.fileManager && typeof this.app.fileManager.processFrontMatter === 'function') {
			try {
				await this.app.fileManager.processFrontMatter(file, (fm) => {
					for (const [key, value] of Object.entries(updates)) {
						fm[key] = value;
					}
				});
				return;
			} catch (e) {
				console.warn('[Steam Sync] processFrontMatter 失败，改用手动更新', e);
			}
		}
		await this.updateFrontmatterManual(file, updates);
	}

	async updateFrontmatterManual(file, updates) {
		await this.app.vault.process(file, (content) => {
			const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
			if (!fmMatch) {
				const yaml = Object.entries(updates)
					.map(([key, value]) => `${key}: ${this.toYamlValue(value)}`)
					.join('\n');
				return `---\n${yaml}\n---\n\n${content}`;
			}
			let block = fmMatch[1];
			for (const [key, value] of Object.entries(updates)) {
				const valueStr = this.toYamlValue(value);
				const re = new RegExp(`^${escapeRegExp(key)}:.*$`, 'm');
				if (re.test(block)) {
					block = block.replace(re, `${key}: ${valueStr}`);
				} else {
					block += `\n${key}: ${valueStr}`;
				}
			}
			return content.replace(fmMatch[0], `---\n${block}\n---`);
		});
	}

	toYamlValue(value) {
		if (typeof value === 'number') return String(value);
		return String(value);
	}

	async createSelectedGames(games, library, platform) {
		let created = 0;
		let failed = 0;
		for (let i = 0; i < games.length; i++) {
			const game = games[i];
			const notice = new Notice(`正在创建 ${i + 1}/${games.length}：${game.name}`, 0);
			try {
				const details = platform ? null : await this.fetchAppDetails(game.appid);
				const path = await this.createGameFile(game, details, library, platform);
				created++;
				console.log(`[Steam Sync] 已创建 ${path}`);
			} catch (e) {
				failed++;
				console.error(`[Steam Sync] 创建 ${game.name} 失败`, e);
			} finally {
				notice.hide();
			}
			if (i < games.length - 1) await sleep(platform ? 150 : 250);
		}
		await this.saveSettings();
		new Notice(`创建完成：成功 ${created} 个，失败 ${failed} 个`);
	}

	async createGameFile(game, details, library, platform) {
		let ach = null;
		if (this.settings.syncAchievements) {
			if (platform === 'psn') {
				ach = await this.fetchPsnTrophies(game.npCommunicationId, { earned: game.trophyEarned, defined: game.trophyDefined });
			} else if (platform === 'xbox') {
				const xuid = await this.getXboxXuid(this.getXboxAuthHeaders());
				ach = await this.fetchXboxAchievements(xuid, game.id, game.scid);
			} else if (!platform && this.activeSteamId) {
				ach = await this.fetchAchievements(this.activeSteamId, game.appid, game);
			}
		}
		const data = platform
			? await this.buildPlatformTemplateData(platform, game, library, ach)
			: await this.buildTemplateData(game, details, library, ach);
		const content = platform
			? this.renderPlatformTemplate(platform, this.settings.template, data)
			: this.renderTemplate(this.settings.template, data);
		const folder = String(this.settings.folder || '').trim();
		if (folder) await this.ensureFolder(folder);

		const baseName = sanitizeFileName(data.name || String(platform ? game.id : game.appid));
		let filePath = folder
			? normalizePath(`${folder}/${baseName}.md`)
			: normalizePath(`${baseName}.md`);

		let index = 1;
		while (this.app.vault.getAbstractFileByPath(filePath)) {
			filePath = folder
				? normalizePath(`${folder}/${baseName} ${index}.md`)
				: normalizePath(`${baseName} ${index}.md`);
			index++;
		}

		const file = await this.app.vault.create(filePath, content);
		if (platform) {
			this.settings.platformAppidMap[`${platform}:${String(game.id)}`] = file.path;
			await this.syncPlatformGameToFile(platform, game, file, ach);
		} else {
			this.settings.appidMap[String(game.appid)] = file.path;
			await this.syncGameToFile(game, file, null, ach);
		}
		await this.appendIndexLink(file.basename);
		return filePath;
	}

	async buildTemplateData(game, details, library, ach) {
		const minutes = game.playtime_forever || 0;
		const hours = Number((minutes / 60).toFixed(1));
		const local = library && library.get(String(game.appid));
		const englishName = game.name || (details && details.name) || `Game ${game.appid}`;
		const chineseName = (details && details.name) || englishName;
		const steamCover = (details && details.header_image) || `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.appid}/header.jpg`;
		const cover = await this.fetchCover(game.appid, steamCover);
		const installed = !!(local && local.installed);
		const absPath = installed ? local.installPath : '';
		const pathValue = absPath ? yamlString(toFileUrl(absPath)) : '';
		const size = installed ? formatSize(local.sizeOnDisk) : '';
		let achievements = '';
		let achievement_list = '';
		if (this.settings.syncAchievements && this.activeSteamId) {
			const res = ach || await this.fetchAchievements(this.activeSteamId, game.appid, game);
			achievements = res.available ? `${res.unlocked}/${res.total}` : '无';
			if (this.settings.writeAchievementList) {
				achievement_list = formatAchievementList(res, this.settings.includeLockedAchievements);
			}
		}

		return {
			name: chineseName,
			english_name: yamlScalar(englishName),
			appid: game.appid,
			playtime: formatPlaytime(minutes),
			playtime_hours: hours,
			playtime_minutes: minutes,
			last_played: formatDateFromTimestamp(game.rtime_last_played),
			cover,
			status: installed ? '已下载' : '未下载',
			source: 'Steam',
			path: pathValue,
			size,
			achievements,
			achievement_list,
			developer: details && details.developers ? details.developers.join(', ') : '',
			publisher: details && details.publishers ? details.publishers.join(', ') : '',
			date: new Date().toISOString().slice(0, 10)
		};
	}

	renderTemplate(template, data) {
		return template.replace(/\{\{(\w+)(?:\|(\w+))?\}\}/g, (match, key, filter) => {
			let value = data[key];
			if (value === undefined || value === null) value = '';
			if (filter === 'yaml') {
				if (Array.isArray(value)) return JSON.stringify(value.map(String));
				return yamlString(value);
			}
			return String(value);
		});
	}

	async appendIndexLink(noteName) {
		const indexPath = normalizePath(String(this.settings.indexFile || '').trim());
		if (!indexPath) return;
		const file = this.app.vault.getAbstractFileByPath(indexPath);
		if (!file) return;
		const link = `- [[${noteName}]]`;
		await this.app.vault.process(file, (content) => {
			if (content.includes(`[[${noteName}]]`)) return content;
			const trimmed = content.replace(/\s*$/, '');
			return `${trimmed}\n${link}\n`;
		});
	}

	async ensureFolder(folder) {
		const parts = normalizePath(folder).split('/').filter(Boolean);
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!(await this.app.vault.adapter.exists(current))) {
				await this.app.vault.createFolder(current).catch(() => {});
			}
		}
	}
}

class GameSelectModal extends Modal {
	constructor(plugin, games, library, platform) {
		super(plugin.app);
		this.plugin = plugin;
		this.games = games;
		this.library = library || new Map();
		this.platform = platform || null;
		this.config = platform ? plugin.getPlatformConfig(platform) : null;
		this.selected = new Set();
		this.filtered = games;
	}

	keyOf(game) {
		return this.platform ? String(game.id) : String(game.appid);
	}

	onOpen() {
		this.modalEl.addClass('steam-sync-modal');
		const { contentEl } = this;
		contentEl.empty();
		const title = this.platform ? `选择要创建的 ${this.config.label} 游戏` : '选择要创建的游戏';
		contentEl.createEl('h2', { text: title });
		contentEl.createEl('p', {
			cls: 'steam-sync-hint',
			text: `已有笔记的游戏不会出现在这里。共 ${this.games.length} 个新游戏，勾选后创建「资源」模板笔记。`
		});

		const searchInput = contentEl.createEl('input', { cls: 'steam-sync-search' });
		searchInput.type = 'text';
		searchInput.placeholder = '搜索游戏...';
		searchInput.addEventListener('input', () => this.renderList(searchInput.value));

		this.listEl = contentEl.createDiv({ cls: 'steam-sync-list' });
		this.renderList('');

		const buttonRow = contentEl.createDiv({ cls: 'steam-sync-actions' });
		buttonRow.createEl('button', { text: '全选' }).addEventListener('click', () => {
			for (const game of this.filtered) this.selected.add(this.keyOf(game));
			this.renderList(searchInput.value);
		});
		buttonRow.createEl('button', { text: '全不选' }).addEventListener('click', () => {
			for (const game of this.filtered) this.selected.delete(this.keyOf(game));
			this.renderList(searchInput.value);
		});
		const confirmBtn = buttonRow.createEl('button', { text: '创建选中的游戏', cls: 'mod-cta' });
		confirmBtn.addEventListener('click', () => this.onConfirm());
		buttonRow.createEl('button', { text: '取消' }).addEventListener('click', () => this.close());
	}

	renderList(filter) {
		this.listEl.empty();
		const lower = String(filter || '').toLowerCase();
		this.filtered = this.games.filter((g) => String(g.name || '').toLowerCase().includes(lower));
		if (!this.filtered.length) {
			this.listEl.createEl('div', { text: '没有匹配的游戏' });
			return;
		}

		for (const game of this.filtered) {
			const key = this.keyOf(game);
			const hours = game.playtime_available === false ? '无数据' : `${((game.playtime_forever || 0) / 60).toFixed(1)} 小时`;
			const lastPlayed = formatDateFromTimestamp(game.rtime_last_played);
			const local = this.library.get(key);
			const installed = local && local.installed ? '已安装' : '未安装';

			const row = this.listEl.createEl('label', { cls: 'steam-sync-row' });
			if (this.selected.has(key)) row.addClass('is-selected');

			const checkbox = row.createEl('input');
			checkbox.type = 'checkbox';
			checkbox.checked = this.selected.has(key);
			checkbox.addEventListener('change', () => {
				if (checkbox.checked) this.selected.add(key);
				else this.selected.delete(key);
				row.toggleClass('is-selected', checkbox.checked);
			});

			const thumb = this.platform
				? game.thumbnail
				: `https://cdn.cloudflare.steamstatic.com/steam/apps/${key}/capsule_231x87.jpg`;
			if (thumb) {
				row.createEl('img', {
					cls: 'steam-sync-thumb',
					attr: { src: thumb, alt: game.name }
				});
			}

			const info = row.createDiv({ cls: 'steam-sync-info' });
			info.createDiv({ cls: 'steam-sync-name', text: game.name });
			info.createDiv({
				cls: 'steam-sync-meta',
				text: `${hours} · 最后玩 ${lastPlayed} · ${installed}`
			});
		}
	}

	onConfirm() {
		if (this.selected.size === 0) {
			new Notice('请至少选择一个游戏');
			return;
		}
		const selectedGames = this.games.filter((g) => this.selected.has(this.keyOf(g)));
		this.close();
		this.plugin.createSelectedGames(selectedGames, this.library, this.platform);
	}

	onClose() {
		this.contentEl.empty();
	}
}


class SteamSyncSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'Steam Sync 设置' });
		containerEl.createEl('p', {
			text: 'Steam API Key：https://steamcommunity.com/dev/apikey 。Steam ID 支持 17 位数字、个人资料 URL 或自定义 URL。游戏详情需设为公开。'
		});

		new Setting(containerEl)
			.setName('Steam API Key')
			.setDesc('用于调用 Steam Web API')
			.addText((text) => {
				text.setPlaceholder('请输入 Steam API Key')
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.type = 'password';
			});

		new Setting(containerEl)
			.setName('Steam ID / 个人资料')
			.setDesc('支持 17 位 steamid、https://steamcommunity.com/profiles/xxx 或 https://steamcommunity.com/id/xxx')
			.addText((text) => {
				text.setPlaceholder('例如 76561198000000000')
					.setValue(this.plugin.settings.steamId)
					.onChange(async (value) => {
						this.plugin.settings.steamId = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('SteamGridDB API Key')
			.setDesc('可留空：会自动读取已安装的 SteamGridDB Embedder。用于给新笔记写入竖版封面 URL')
			.addText((text) => {
				text.setPlaceholder('可留空，自动使用 SteamGridDB Embedder')
					.setValue(this.plugin.settings.steamGridDBApiKey)
					.onChange(async (value) => {
						this.plugin.settings.steamGridDBApiKey = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.type = 'password';
			});

		new Setting(containerEl)
			.setName('笔记文件夹')
			.setDesc('新建游戏 MD 会放在这里，也会优先扫描这里匹配已有游戏')
			.addText((text) => {
				text.setPlaceholder('资源库/游戏')
					.setValue(this.plugin.settings.folder)
					.onChange(async (value) => {
						this.plugin.settings.folder = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('索引文件')
			.setDesc('创建新游戏后，自动往这个文件追加 [[链接]]')
			.addText((text) => {
				text.setPlaceholder('资源库/游戏.md')
					.setValue(this.plugin.settings.indexFile)
					.onChange(async (value) => {
						this.plugin.settings.indexFile = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Steam 库路径')
			.setDesc('用于填写「路径 / 大小 / 状态」。会读取 steamapps/appmanifest_*.acf')
			.addText((text) => {
				text.setPlaceholder('D:/Gamelib/SteamLibrary')
					.setValue(this.plugin.settings.steamLibraryPath)
					.onChange(async (value) => {
						this.plugin.settings.steamLibraryPath = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('只显示有游玩时长的新游戏')
			.setDesc('开启后，选择窗口只列出时长大于 0、且还没有笔记的游戏（仅 Steam / PSN 生效，Xbox 与 Epic 时长需逐游戏获取）')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.showOnlyPlayed)
					.onChange(async (value) => {
						this.plugin.settings.showOnlyPlayed = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('给已有笔记写入 steam_appid')
			.setDesc('同步时长时顺便写入 AppID，方便下次精确匹配。不会改封面、路径、备注')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.writeAppId)
					.onChange(async (value) => {
						this.plugin.settings.writeAppId = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('同步成就完成度')
			.setDesc('写入 frontmatter「成就: 12/54」，看板卡片会显示这个完成度')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.syncAchievements)
					.onChange(async (value) => {
						this.plugin.settings.syncAchievements = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('在笔记底部写入成就列表')
			.setDesc('写成 Markdown 表格：图标、名字、说明、时间、所有玩家完成百分比')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.writeAchievementList)
					.onChange(async (value) => {
						this.plugin.settings.writeAchievementList = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('列出未完成成就')
			.setDesc('关闭则表格只含已解锁；开启则未解锁显示为「未解锁」')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.includeLockedAchievements)
					.onChange(async (value) => {
						this.plugin.settings.includeLockedAchievements = value;
						await this.plugin.saveSettings();
					});
			});

		containerEl.createEl('h3', { text: 'PSN（实验性）' });
		containerEl.createEl('p', {
			text: '需要 PSN Access Token，推荐同时填写 Refresh Token（psn-api 登录后返回的 refreshToken，有效期约 2 个月）。Access Token 过期时插件会自动用 Refresh Token 刷新，无需每次手动重新获取。'
		});

		new Setting(containerEl)
			.setName('PSN 数据来源')
			.setDesc('GameList API：使用 PlayStation 游戏列表 API 获取游戏和游玩数据。Trophy API：使用 PlayStation Trophy API 获取用户 Trophy 游戏和奖杯数据。切换后点击同步即可。')
			.addDropdown((dropdown) => {
				dropdown
					.addOption('gamelist', 'GameList API')
					.addOption('trophy', 'Trophy API')
					.setValue(this.plugin.settings.psnDataSource || 'gamelist')
					.onChange(async (value) => {
						this.plugin.settings.psnDataSource = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('PSN Access Token')
			.setDesc('OAuth access_token，Bearer 后面的值')
			.addText((text) => {
				text.setPlaceholder('请输入 PSN Access Token')
					.setValue(this.plugin.settings.psnAccessToken)
					.onChange(async (value) => {
						this.plugin.settings.psnAccessToken = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.type = 'password';
			});

		new Setting(containerEl)
			.setName('PSN Refresh Token')
			.setDesc('可选：psn-api 返回的 refreshToken。Access Token 过期时自动刷新，避免反复手动获取')
			.addText((text) => {
				text.setPlaceholder('可选')
					.setValue(this.plugin.settings.psnRefreshToken)
					.onChange(async (value) => {
						this.plugin.settings.psnRefreshToken = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.type = 'password';
			});

		containerEl.createEl('h3', { text: 'Xbox（实验性）' });
		containerEl.createEl('p', {
			text: '需要 Xbox Live 的 XBL3.0 Authorization 头。可用 OpenXbox/xbox-webapi-python 等工具登录后获取。xuid 可留空自动获取。'
		});

		new Setting(containerEl)
			.setName('Xbox XBL3.0 Authorization')
			.setDesc('完整 Authorization 头，例如 XBL3.0 x=...;...')
			.addText((text) => {
				text.setPlaceholder('XBL3.0 x=...;...')
					.setValue(this.plugin.settings.xboxAuthorization)
					.onChange(async (value) => {
						this.plugin.settings.xboxAuthorization = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.type = 'password';
			});

		new Setting(containerEl)
			.setName('Xbox xuid')
			.setDesc('可选：留空自动通过 profile 接口获取')
			.addText((text) => {
				text.setPlaceholder('例如 2533274812345678')
					.setValue(this.plugin.settings.xboxXuid)
					.onChange(async (value) => {
						this.plugin.settings.xboxXuid = value.trim();
						await this.plugin.saveSettings();
					});
			});

		containerEl.createEl('h3', { text: 'Epic（实验性）' });
		containerEl.createEl('p', {
			text: '可填 Epic Access Token 读取完整游戏库；不填则只读取本地 Epic 清单中的已安装游戏。'
		});

		new Setting(containerEl)
			.setName('Epic Access Token')
			.setDesc('可选：Epic 账号 OAuth access_token')
			.addText((text) => {
				text.setPlaceholder('可选')
					.setValue(this.plugin.settings.epicAccessToken)
					.onChange(async (value) => {
						this.plugin.settings.epicAccessToken = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.type = 'password';
			});

		new Setting(containerEl)
			.setName('Epic 本地清单目录')
			.setDesc('未填 Access Token 时，读取该目录下的 *.item 清单')
			.addText((text) => {
				text.setPlaceholder('C:/ProgramData/Epic/EpicGamesLauncher/Data/Manifests')
					.setValue(this.plugin.settings.epicManifestPath)
					.onChange(async (value) => {
						this.plugin.settings.epicManifestPath = value.trim();
						await this.plugin.saveSettings();
					});
			});



		new Setting(containerEl)
			.setName('MD 模板')
			.setDesc('占位符：{{name}} {{english_name}} {{appid}} {{playtime}} {{playtime_hours}} {{playtime_minutes}} {{last_played}} {{achievements}} {{achievement_list}} {{cover}} {{status}} {{source}} {{path}} {{size}} {{date}}。非 Steam 平台创建时会把「来源: Steam」和「steam_appid」自动替换为对应平台')
			.setClass('steam-sync-settings-template')
			.addTextArea((text) => {
				text.setValue(this.plugin.settings.template)
					.onChange(async (value) => {
						this.plugin.settings.template = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.addButton((button) => {
				button.setButtonText('恢复默认模板')
					.onClick(async () => {
						this.plugin.settings.template = DEFAULT_TEMPLATE;
						await this.plugin.saveSettings();
						this.display();
					});
			});
	}
}

module.exports = SteamSyncPlugin;
