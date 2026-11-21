'use strict';
'require view';
'require rpc';
'require poll';
'require fs';

/* ---------- ubus 接口 ---------- */
var callBoard   = rpc.declare({ object: 'system', method: 'board' });
var callSysInfo = rpc.declare({ object: 'system', method: 'info' });
/* 不再写死 network.interface.wan / wan_6：
   不同固件里 WAN 逻辑接口可能叫 wan / wwan / wan6 / wan_6，
   直接 dump 全部接口再自己挑，任何版本都能用 */
var callIfaces   = rpc.declare({ object: 'network.interface', method: 'dump' });
var callNetDevs  = rpc.declare({ object: 'luci-rpc', method: 'getNetworkDevices' });
var callLeases   = rpc.declare({ object: 'luci-rpc', method: 'getDHCPLeases' });
var callRealtime = rpc.declare({
	object: 'luci', method: 'getRealtimeStats',
	params: [ 'mode', 'device' ], expect: { result: [] }
});
var callBandix = rpc.declare({
	object: 'luci.bandix', method: 'getStatus',
	params: [ 'start_ms', 'end_ms' ], expect: { d: [] }
});
var callRank = rpc.declare({
	object: 'luci.bandix', method: 'getTrafficUsageRanking',
	params: [ 'start_ms', 'end_ms', 'network_type' ], expect: { r: [] }
});
var callPing = rpc.declare({
	object: 'file', method: 'exec',
	params: [ 'command', 'params' ], nobatch: true
});
/* 概览页那几个系统字段直接取 luci 的现成接口，数值与原生概览页一致 */
/* 这三个方法来自 luci-mod-status，但不同固件不一定都实现了；
   加上 nobatch 单独调用：实测混在批量请求里偶发只返回一个 "?" */
var callVersion  = rpc.declare({ object: 'luci', method: 'getVersion', nobatch: true });
var callCpuInfo  = rpc.declare({ object: 'luci', method: 'getCPUInfo', nobatch: true });
var callTempInfo = rpc.declare({ object: 'luci', method: 'getTempInfo', nobatch: true });

/* 延迟探测：阿里 DNS，3 包取均值 */
var PING_BIN = '/bin/ping';
var PING_ARGS = [ '-c', '3', '-W', '1', '-q', '223.5.5.5' ];

/* ---------- 小工具 ---------- */
/* LuCI 没有全局的元素构造助手，必须自带，否则真机 render 直接 ReferenceError */
function appendChildren(node, ch) {
	if (ch == null) return;
	if (Array.isArray(ch)) {
		for (var i = 0; i < ch.length; i++) appendChildren(node, ch[i]);
		return;
	}
	if (ch instanceof Node) {
		node.appendChild(ch);
		return;
	}
	node.appendChild(document.createTextNode(String(ch)));
}

/* LuCI 的 rpc.declare 带 expect 时会自动解包该字段：
   定义 expect:{d:[]} 时，拿到的直接是 d 数组，而不是 {d:[...]}。
   两种形态都要兼容，否则真机取值为空、mock 却正常。 */
function pickArray(v, key) {
	if (Array.isArray(v)) return v;
	if (v && Array.isArray(v[key])) return v[key];
	return [];
}

function E(tag, attrs, children) {
	var node = document.createElement(tag);
	if (attrs) {
		for (var k in attrs) {
			var v = attrs[k];
			if (v == null || v === false) continue;
			if (k === 'style') node.style.cssText = v;
			else if (v === true) node.setAttribute(k, '');
			else node.setAttribute(k, v);
		}
	}
	appendChildren(node, children);
	return node;
}
var POLL_MS = 2000;			// 基础节拍：2 秒（1 秒实测多耗 20% CPU 余量，不值）
var T_DEV = 1;				// 设备表 / 每台速率：每拍 = 2 秒
var T_DAY = 5;				// 今日流量：10 秒（变化慢）
var T_SLOW = 15;				// 慢速项（ping 延迟）：30 秒
var ONLINE_WINDOW = 5 * 60 * 1000;	// 5 分钟内有流量 = 在线
var SERIES_LEN = 60;			// 曲线保留 60 个 1 秒采样点

function icon(inner) {
	var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	s.setAttribute('viewBox', '0 0 24 24');
	s.innerHTML = inner;
	return s;
}

function loadCss() {
	if (document.querySelector('link[data-hpcss]')) return;
	var lk = document.createElement('link');
	lk.rel = 'stylesheet';
	lk.type = 'text/css';
	lk.href = L.resource('homepanel/app.css') + '?v=20261029i';
	lk.setAttribute('data-hpcss', '1');
	document.head.appendChild(lk);
}

function pad(n) { return n < 10 ? '0' + n : '' + n; }

/* 今天 00:00 的时间戳（设备本地时区） */
function dayStart(ms) {
	var d = new Date(ms);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

function fmtBytes(b) {
	if (b == null || isNaN(b)) return '—';
	b = +b;
	if (b < 1024) return b + ' B';
	if (b < 1048576) return (b / 1024).toFixed(b < 10240 ? 1 : 0) + ' KB';
	if (b < 1073741824) return (b / 1048576).toFixed(b < 10485760 ? 1 : 0) + ' MB';
	return (b / 1073741824).toFixed(2) + ' GB';
}

function fmtRate(bps) {
	if (bps == null || isNaN(bps)) return '0 B/s';
	bps = Math.max(0, bps);
	if (bps < 1024) return Math.round(bps) + ' B/s';
	if (bps < 1048576) return (bps / 1024).toFixed(1) + ' KB/s';
	return (bps / 1048576).toFixed(2) + ' MB/s';
}

function fmtDur(sec) {
	sec = Math.max(0, Math.floor(+sec || 0));
	var d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
	if (d > 0) return d + 'd ' + h + 'h';
	if (h > 0) return h + 'h ' + pad(m) + 'm';
	return m + 'm';
}

function fmtUptimeShort(sec) {
	sec = Math.max(0, Math.floor(+sec || 0));
	var d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600);
	if (d > 0) return d + 'd ' + h + 'h';
	return Math.floor(sec / 3600) + 'h ' + pad(Math.floor(sec % 3600 / 60)) + 'm';
}

/* IPv6 地址按 /64 边界折成两段显示 */
function splitV6(addr) {
	if (!addr) return [ '', '' ];
	if (addr.indexOf('::') >= 0) {
		var h = addr.split('::'), a = h[0] ? h[0].split(':') : [], b = h[1] ? h[1].split(':') : [];
		var fill = 8 - a.length - b.length, mid = [];
		for (var i = 0; i < fill; i++) mid.push('0');
		var full = a.concat(mid, b);
		return [ full.slice(0, 4).join(':') + ':', full.slice(4).join(':') ];
	}
	var p = addr.split(':');
	if (p.length >= 8) return [ p.slice(0, 4).join(':') + ':', p.slice(4).join(':') ];
	return [ addr, '' ];
}

function devIcon(kind) {
	if (kind === 'wifi') return '<svg viewBox="0 0 24 24"><path d="M4 9a13 13 0 0 1 16 0M7 13a8 8 0 0 1 10 0M10.5 16.5a3 3 0 0 1 3 0"/><circle cx="12" cy="19" r="1"/></svg>';
	if (kind === 'router') return '<svg viewBox="0 0 24 24"><rect x="3" y="12" width="18" height="8" rx="2"/><path d="M7 16h.01M12 16h.01M17 16h.01M12 12V8"/><circle cx="12" cy="5" r="1.6"/></svg>';
	return '<svg viewBox="0 0 24 24"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="M16 10l6-3v10l-6-3z"/></svg>';
}

/* ---------- 视图 ---------- */
return view.extend({

	series: { rx: [], tx: [] },
	lastSample: null,
	copyBound: false,

	load: function(due) {
		var now = Date.now();
		var c = this.cache || (this.cache = {});
		/* LuCI 首次渲染调用 load() 不带参数 —— 此时必须全量拉取，否则首屏空白 */
		due = due || { dev: true, day: true, slow: true };

		var pBoard = c.board ? Promise.resolve(c.board) : L.resolveDefault(callBoard(), {});

		var pDev = due.dev
			? L.resolveDefault(callBandix(now - 3600000, now), { d: [] })
			: Promise.resolve(c.bandix || { d: [] });

		var pDay = due.day
			? L.resolveDefault(callRank(dayStart(now), now, 'all'), { r: [] })
			: Promise.resolve(c.day || { r: [] });

		var pPing = due.slow ? L.resolveDefault(callPing(PING_BIN, PING_ARGS), { code: 1 })
		                   : Promise.resolve(c.ping || { code: 1 });
		var pVer = due.slow ? L.resolveDefault(callVersion(), {}) : Promise.resolve(c.ver || {});
		var pCpuInfo = due.slow ? L.resolveDefault(callCpuInfo(), {}) : Promise.resolve(c.cpuinfo || {});
		var pTempInfo = due.slow ? L.resolveDefault(callTempInfo(), {}) : Promise.resolve(c.tempinfo || {});
		var pNetDevs = due.slow ? L.resolveDefault(callNetDevs(), {}) : Promise.resolve(c.netdevs || {});
		var pLeases = due.slow ? L.resolveDefault(callLeases(), {}) : Promise.resolve(c.leases || {});

		/* bandix 没装时（或列表为空）改走 ARP + DHCP 租约兜底，先读一次现成的 */
		var needArp = (this.bandixOk !== true) || due.slow;
		var pArp = needArp ? L.resolveDefault(fs.read('/proc/net/arp'), '') : Promise.resolve('');

		return Promise.all([
			pBoard,						/* 0  */
			L.resolveDefault(callSysInfo(), {}),		/* 1  */
			L.resolveDefault(callIfaces(), {}),		/* 2  */
			pNetDevs,					/* 3  */
			pDev,						/* 4  */
			L.resolveDefault(fs.read('/proc/stat'), ''),	/* 5  */
			L.resolveDefault(fs.read('/proc/loadavg'), ''),	/* 6  */
			pPing,						/* 7  */
			pVer,						/* 8  */
			pCpuInfo,					/* 9  */
			pTempInfo,					/* 10 */
			pLeases,					/* 11 */
			pArp,						/* 12 */
			L.resolveDefault(fs.read('/sys/class/thermal/thermal_zone0/temp'), '')	/* 13 */
		]).then(L.bind(function(r) {
			return pDay.then(L.bind(function(day) {
				if (due.day) { c.day = day; this.rank = pickArray(day, 'r'); }
				else if (!this.rank) this.rank = pickArray(c.day, 'r');

				if (due.dev) c.bandix = r[4];
				if (due.slow) {
					c.ping = r[7]; c.ver = r[8];
					c.cpuinfo = r[9]; c.tempinfo = r[10];
					c.netdevs = r[3]; c.leases = r[11];
					this.netDevs = r[3] || {};
				}
				c.board = r[0];
				this.cache = c;

				/* bandix 是否可用：只要出现过设备就认定可用，之后不再回退 */
				if (due.dev) {
					var n = pickArray(r[4], 'd').length;
					if (n > 0) this.bandixOk = true;
					else if (this.bandixOk !== true) this.bandixOk = false;
				}

				var wan = pickWan(r[2]);
				var wdev = (wan && (wan.l3_device || wan.device)) || 'eth1';
				return L.resolveDefault(callRealtime('interface', wdev), { result: [] }).then(L.bind(function(rt) {
					/* 个别设备（如虚拟网卡名不匹配）取不到采样，换物理设备再试一次 */
					if (!pickArray(rt, 'result').length && wan && wan.device && wan.device !== wdev) {
						return L.resolveDefault(callRealtime('interface', wan.device), { result: [] }).then(function(rt2) {
							r.push(rt2); r.push(wan.device);
							return r;
						});
					}
					r.push(rt);
					r.push(wdev);
					return r;
				}));
			}, this));
		}, this));
	},

	render: function(data) {
		try {
			return this.paint(data);
		}
		catch (e) {
			if (window.console) console.error('[homepanel] render failed', e);
			return E('div', { 'class': 'n60-err' },
				'面板渲染出错：' + ((e && e.message) ? e.message : String(e)));
		}
	},

	paint: function(data) {
		var board = data[0] || {}, info = data[1] || {}, wan = data[2] || {}, wan6 = data[3] || {};
		loadCss();

		var hostname = board.hostname || 'Router';
		var model = (board.model || '') + (board.release ? ' · ' + board.release.distribution + ' ' + board.release.version : '');

		var root = E('div', { 'class': 'n60' }, [
			E('div', { 'class': 'n60-grid' }, [

				/* 0 身份长卡：主机名 / 型号 / 状态 pill。
				   独立成卡后，文字不再压在顶栏与内容区的颜色交界上 */
				E('section', { 'class': 'card hdr' }, [
					E('div', { 'class': 'lg' }, [
						icon('<path d="M4.5 11.5a11 11 0 0 1 15 0"/><path d="M7.8 15a6.6 6.6 0 0 1 8.4 0"/><circle cx="12" cy="18.4" r="1.4"/>')
					]),
					E('div', { 'class': 'tt' }, [
						E('b', { id: 'n60-host' }, hostname),
						E('span', { id: 'n60-model' }, model)
					]),
					E('div', { 'class': 'n60-pills' }, [
						E('span', { 'class': 'n60-pill', id: 'n60-pill-net' }, [ E('i', { 'class': 'dot' }), '互联网正常' ]),
						E('span', { 'class': 'n60-pill', id: 'n60-pill-up' }, '运行 —')
					])
				]),

				/* 1~5 KPI 五连（20% 等分，不切 12 栅格） */
				E('div', { 'class': 'krow' }, [
					/* 1 公网地址 */
					E('section', { 'class': 'card kpi' }, [
						E('div', { 'class': 'lab' }, [
							E('span', { 'class': 'ic' }, [ icon('<path d="M12 3v4M5 8h14M6 8l-2 7h6L8 8M18 8l2 7h-6l2-7"/><path d="M8 20h8"/>') ]),
							'公网地址',
							E('span', { 'class': 'dual', id: 'n60-dual' }, '双栈')
						]),
						E('div', { 'class': 'wan-row' }, [
							E('span', { 'class': 'fam' }, 'IPv4'),
							E('div', { style: 'min-width:0' }, [
								E('div', { 'class': 'v4 num', id: 'n60-v4', 'data-copy': '' }, '—'),
								E('div', { 'class': 'exp', id: 'n60-v4exp' }, '—')
							])
						]),
						E('div', { 'class': 'wan-row' }, [
							E('span', { 'class': 'fam v6' }, 'IPv6'),
							E('div', { style: 'min-width:0' }, [
								E('div', { 'class': 'v6', id: 'n60-v6', 'data-copy': '' }, '—'),
								E('div', { 'class': 'exp', id: 'n60-v6exp' }, '—')
							])
						])
					]),

					/* 2 实时吞吐 */
					E('section', { 'class': 'card kpi' }, [
						E('div', { 'class': 'lab g' }, [
							E('span', { 'class': 'ic' }, [ icon('<path d="M7 17V9M12 17V5M17 17v-6"/>') ]),
							'实时吞吐',
							E('span', { style: 'margin-left:auto;font-size:10px;color:#9aa1af' }, '60s')
						]),
						E('div', { 'class': 'big num' }, [
							E('span', { id: 'n60-rx' }, '0'),
							E('small', { id: 'n60-rxunit' }, 'B/s ↓')
						]),
						E('div', { 'class': 'spark', id: 'n60-spark' }),
						E('div', { 'class': 'foot' }, [
							E('span', {}, [ '上行 ', E('b', { 'class': 'num', id: 'n60-tx' }, '—' ) ]),
							'·',
							E('span', { id: 'n60-total' }, '累计 —')
						])
					]),

					/* 3 在线设备 */
					E('section', { 'class': 'card kpi' }, [
						E('div', { 'class': 'lab v' }, [
							E('span', { 'class': 'ic' }, [ icon('<rect x="2" y="4" width="13" height="10" rx="2"/><rect x="17" y="9" width="5" height="9" rx="1.6"/><path d="M8 18h5"/>') ]),
							'在线设备',
							E('span', { style: 'margin-left:auto;font-size:10px;color:#9aa1af' }, '5 分钟内活跃')
						]),
						E('div', { 'class': 'big num' }, [
							E('span', { id: 'n60-online' }, '0'),
							E('small', {}, '台')
						]),
						E('div', { 'class': 'dots', id: 'n60-dots' }),
						E('div', { 'class': 'foot' }, [
							E('span', {}, [ '有线 ', E('b', { id: 'n60-wired' }, '0' ) ]),
							'·',
							E('span', {}, [ '无线 ', E('b', { id: 'n60-wifi' }, '0' ) ])
						])
					]),

					/* 4 CPU 使用率 */
					E('section', { 'class': 'card kpi' }, [
						E('div', { 'class': 'lab o' }, [
							E('span', { 'class': 'ic' }, [ icon('<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/>') ]),
							'CPU 使用率',
							E('span', { style: 'margin-left:auto;font-size:10px;color:#9aa1af', id: 'n60-cpucore' }, '—')
						]),
						E('div', { 'class': 'big num' }, [
							E('span', { id: 'n60-cpupct' }, '0'),
							E('small', { id: 'n60-cpuunit' }, '%')
						]),
						E('div', { 'class': 'prog', id: 'n60-cpuprog' }, [ E('i', { style: 'width:0%' }) ]),
						E('div', { 'class': 'foot', id: 'n60-cpufoot' }, '—')
					]),

					/* 5 内存 */
					E('section', { 'class': 'card kpi' }, [
						E('div', { 'class': 'lab' }, [
							E('span', { 'class': 'ic' }, [ icon('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 15v-4M12 15V8M16 15v-6"/>') ]),
							'内存占用',
							E('span', { style: 'margin-left:auto;font-size:10px;color:#9aa1af', id: 'n60-memtot' }, '—')
						]),
						E('div', { 'class': 'big num' }, [
							E('span', { id: 'n60-mempct' }, '0'),
							E('small', {}, '%')
						]),
						E('div', { 'class': 'prog', id: 'n60-memprog' }, [ E('i', { style: 'width:0%' }) ]),
						E('div', { 'class': 'foot', id: 'n60-memfoot' }, '—')
					])
				]),

				/* 6 流量图 */
				E('section', { 'class': 'card chart' }, [
					E('h3', {}, [
						'WAN 实时流量',
						E('span', { 'class': 'legend', style: 'margin-left:14px' }, [
							E('span', {}, [ E('i', { style: 'background:#3b5bfd' }), '下行' ]),
							E('span', {}, [ E('i', { style: 'background:#c9d0e8' }), '上行' ])
						]),
						E('span', { 'class': 'sub', id: 'n60-devname' }, '')
					]),
					E('div', { 'class': 'chartbox', id: 'n60-area' })
				]),

				/* 7 系统（图表右侧） */
				E('section', { 'class': 'card sys' }, [
					E('h3', {}, [ '系统' ]),
					E('div', { id: 'n60-sysinfo' })
				]),

				/* 7 设备表 */
				E('section', { 'class': 'card tbl', id: 'n60-tblcard' }, [
					E('h3', {}, [ '在线设备', E('span', { 'class': 'sub', id: 'n60-devsub' }, '—' ) ]),
					E('table', {}, [
						E('thead', {}, [ E('tr', {}, [
							E('th', { style: 'width:38%' }, '设备'),
							E('th', {}, 'IP 地址'),
							E('th', {}, '接入'),
							E('th', { 'class': 'r' }, '速率'),
							E('th', { 'class': 'r' }, '今日')
						]) ]),
						E('tbody', { id: 'n60-tbody' })
					])
				])
			])
		]);

		this.apply(root, data, true);

		this.tick = 0;
		this.cache = null;

		poll.add(L.bind(function() {
			var t = this.tick++;
			return this.load({
				dev: (t % T_DEV === 0),
				day: (t % T_DAY === 0),
				slow: (t % T_SLOW === 0)
			}).then(L.bind(function(d) {
				this.apply(root, d, false);
			}, this));
		}, this), POLL_MS / 1000);

		/* Argon 等主题的顶栏是浮层，插入后再量一次重叠高度补上间距 */
		var self = this;
		setTimeout(function() { self.avoidHeader(root); }, 0);

		return root;
	},

	/* 顶栏遮挡修正：render 返回时节点尚未入文档，轮询等它挂上再做一次测量 */
	avoidHeader: function(root, tries) {
		var self = this;
		tries = tries || 0;
		if (!root.parentNode) {
			if (tries < 25) setTimeout(function() { self.avoidHeader(root, tries + 1); }, 80);
			return;
		}
		var hd = document.querySelector('header');
		if (!hd) return;
		var overlap = hd.getBoundingClientRect().bottom - root.getBoundingClientRect().top;
		if (overlap > 4) root.style.paddingTop = Math.round(overlap + 12) + 'px';
	},

	/* 从原始数据算出所有派生值 */
	derive: function(data) {
		var board = data[0] || {}, info = data[1] || {}, dump = data[2] || {};
		var bd = data[4] || {}, statTxt = data[5] || '';
		var loadavg = (data[6] || '').trim().split(/\s+/);
		var ping = data[7] || {};
		var ver = data[8] || {}, cpuInfo = data[9] || {}, tempInfo = data[10] || {};
		var leases = data[11] || {}, arpTxt = data[12] || '';
		var tempRaw = parseInt(data[13] || '0', 10) || 0;
		var rt = data[14] || { result: [] };
		var wdev = data[15] || '';

		var now = Date.now();

		/* WAN / IPv6：全部从 network.interface dump 里推，不依赖接口命名 */
		var wan = pickWan(dump) || {};
		var v4 = '—';
		if (wan['ipv4-address'] && wan['ipv4-address'][0])
			v4 = wan['ipv4-address'][0].address || '—';

		var v6 = '', v6valid = 0;
		var v6c = pickV6(dump, wan);
		if (v6c) { v6 = v6c.address; v6valid = v6c.valid || 0; }

		/* 内存 */
		var mem = info.memory || {};
		var mtotal = mem.total || 0, mavail = mem.available || 0;
		var mused = Math.max(0, mtotal - mavail);
		var mpct = mtotal ? Math.round(mused / mtotal * 100) : 0;

		/* 实时速率：取最后一个采样区间 */
		var points = pickArray(rt, 'result');
		var rxRate = 0, txRate = 0;
		for (var i = points.length - 1; i > 0; i--) {
			var a = points[i - 1], b = points[i];
			var dt = b[0] - a[0];
			if (dt > 0 && b[1] >= a[1] && b[3] >= a[3]) {
				rxRate = (b[1] - a[1]) / dt;
				txRate = (b[3] - a[3]) / dt;
				break;
			}
		}

		/* 累计流量（自接口建立） */
		var last = points.length ? points[points.length - 1] : null;
		var accRx = last ? last[1] : 0, accTx = last ? last[3] : 0;

		/* 设备：优先 bandix（有每台速率/流量），没有就退回 ARP + DHCP 租约 */
		var devs = pickArray(bd, 'd').filter(function(x) { return x && x.mac; });
		var fallback = false;
		if (!devs.length) {
			fallback = true;
			var wanDevs = {};
			wanDevs[wan.l3_device] = 1;
			wanDevs[wan.device] = 1;
			devs = arpDevices(arpTxt, leases, wanDevs);
		}
		var online = devs.filter(function(x) {
			return x.conn !== 'router' && (now - (x.last || 0)) < ONLINE_WINDOW;
		});
		online.sort(function(a, b) { return (b.last || 0) - (a.last || 0); });

		var wired = 0, wifi = 0;
		var self = this;
		online.forEach(function(x) {
			if (self.wifiOf(x)) wifi++; else wired++;
		});

		/* CPU：/proc/stat 是累计 jiffies，必须用两次采样的差值；首次没有基线就留空 */
		var cpu = parseCpu(statTxt);
		var cpupct = null;
		var prev = this.cpuPrev;
		if (prev && cpu.total > prev.total) {
			var dtotal = cpu.total - prev.total;
			var didle = cpu.idle - prev.idle;
			cpupct = Math.max(0, Math.min(100, Math.round((1 - didle / dtotal) * 100)));
		}
		if (cpu.total) this.cpuPrev = cpu;

		/* 延迟：ping 输出的 round-trip min/avg/max，取 avg */
		var lat = null;
		if (ping && ping.code === 0 && ping.stdout) {
			var lm = /=\s*[\d.]+\/([\d.]+)\//.exec(ping.stdout);
			if (lm) lat = parseFloat(lm[1]);
		}

		/* 温度：thermal_zone 是毫摄氏度 */
		var tempC = tempRaw > 1000 ? tempRaw / 1000 : tempRaw;

		/* 架构 / 温度两行：优先用固件自带的接口（取值和原生概览页一致），
		   但 ImmortalWrt 之外的固件没有 getCPUInfo/getTempInfo，而且这两个接口
		   偶发返回一个孤零零的 "?"。取不到就自己用 board + 核数 + thermal 拼。 */
		var cpuStr = txtOf(cpuInfo.cpuinfo);
		if (!cpuStr) {
			var sysName = board.system || board.machine || '';
			cpuStr = (sysName ? sysName : (cpu.cores ? (cpu.cores + ' 核') : '—')) +
				(sysName && cpu.cores ? ' x ' + cpu.cores : '') +
				(tempC ? ' (' + tempC.toFixed(1) + '°C)' : '');
		}
		var tempStr = txtOf(tempInfo.tempinfo);
		if (!tempStr && tempC) tempStr = 'CPU: ' + tempC.toFixed(1) + '°C';

		return {
			hostname: board.hostname || 'Router',
			board: board,
			v4: v4, v6: v6, v6valid: v6valid,
			uplink: wan.uptime || 0, wanup: !!wan.up, wan6up: !!v6,
			mtotal: mtotal, mavail: mavail, mused: mused, mpct: mpct,
			rxRate: rxRate, txRate: txRate, accRx: accRx, accTx: accTx,
			online: online, wired: wired, wifi: wifi, devs: devs, fallback: fallback,
			cpupct: cpupct, cpucores: cpu.cores, lat: lat,
			load: loadavg, temp: tempC,
			cpuStr: cpuStr, tempStr: tempStr,
			firmware: (board.release && board.release.description ? board.release.description : '') +
				(ver.branch ? ' / ' + ver.branch + ' ' + (ver.revision || '') : ''),
			platform: (board.release && board.release.target) || '',
			kernel: board.kernel || '',
			model: board.model || '',
			root: info.root || {}, uptime: info.uptime || 0,
			wdev: wdev
		};
	},

	/* 无线判定：luci-rpc 的 wireless 字段只在 true 时可信（MTK/部分固件里
	   无线网卡也报 false），所以 true 直接用，false/缺失再走命名规则兜底 */
	wifiOf: function(x) {
		var up = (x && x.uplink) || '';
		var map = this.netDevs || {};
		if (map[up] && map[up].wireless === true) return true;
		if (/^(rax|rai|ra\d|wlan|ath|wl|phy\d+-ap|apcli)/.test(up)) return true;
		return false;
	},

	apply: function(root, data, first) {
		var s = this.derive(data);
		var $ = function(id) { return root.querySelector('#' + id); };
		var set = function(id, txt) { var n = $(id); if (n) n.textContent = txt; };
		var html = function(id, h) { var n = $(id); if (n) n.innerHTML = h; };

		/* 顶栏 pill */
		var pn = $('n60-pill-net');
		if (pn) {
			pn.className = 'n60-pill' + (s.wanup ? '' : ' down');
			pn.innerHTML = '<i class="dot"></i>' + (s.wanup ? '互联网正常' : 'WAN 断开');
		}
		/* 身份卡 */
		set('n60-host', s.hostname);
		set('n60-model', (s.board.model || '') +
			(s.board.release ? ' · ' + s.board.release.distribution + ' ' + s.board.release.version : ''));
		set('n60-pill-up', '运行 ' + fmtUptimeShort(s.uptime));

		/* 公网地址 */
		set('n60-v4', s.v4);
		var v4n = $('n60-v4');
		if (v4n) v4n.setAttribute('data-copy', s.v4);
		var latTxt = '';
		if (s.wanup) {
			latTxt = (s.lat != null)
				? ' · 延迟 <b class="lat ' + (s.lat < 60 ? 'ok' : s.lat < 150 ? 'mid' : 'bad') + '">' +
					Math.round(s.lat) + ' ms</b>'
				: ' · 延迟 —';
		}
		/* 卡片只有 269px 宽，宁可省掉"PPP 拨号"，也不能让延迟被省略号吃掉 */
		html('n60-v4exp', (s.wanup ? ('在线 ' + fmtDur(s.uplink)) : '未连接') + latTxt);

		var v6n = $('n60-v6');
		if (s.v6 && s.v6 !== '—') {
			var sp = splitV6(s.v6);
			html('n60-v6', '<span>' + sp[0] + '</span>' + (sp[1] ? '<br><em>' + sp[1] + '</em>' : ''));
			if (v6n) v6n.setAttribute('data-copy', s.v6);
			set('n60-v6exp', s.v6valid ? ('有效期 ' + fmtDur(s.v6valid)) : '已获取地址');
			set('n60-dual', '双栈');
		}
		else {
			html('n60-v6', '<span style="color:#9aa1af">未获取</span>');
			if (v6n) v6n.removeAttribute('data-copy');
			set('n60-v6exp', '该线路未下发 IPv6');
			var d = $('n60-dual');
			if (d) { d.textContent = '单栈'; d.style.color = '#c47b00'; d.style.background = '#fff6e5'; d.style.borderColor = '#ffe9bf'; }
		}

		/* 吞吐：曲线直接用接口返回的 60 个 1 秒采样点重建，
		   刷新节拍快慢都不影响曲线密度，也不会把断点连成假数据 */
		var pts = pickArray(data[14], 'result');
		if (pts.length > 1) this.seedSeries(pts);

		var rxTxt = fmtRate(s.rxRate);
		var i = rxTxt.lastIndexOf(' ');
		set('n60-rx', rxTxt.slice(0, i));
		set('n60-rxunit', rxTxt.slice(i + 1) + ' ↓');
		set('n60-tx', fmtRate(s.txRate));
		set('n60-total', '累计 ↓' + fmtBytes(s.accRx) + ' ↑' + fmtBytes(s.accTx));
		this.spark($('n60-spark'));

		/* 设备 */
		set('n60-online', s.online.length);
		/* 兜底模式下拿不到无线/有线归属，别硬猜，直接显示 — */
		set('n60-wired', s.fallback ? '—' : s.wired);
		set('n60-wifi', s.fallback ? '—' : s.wifi);
		var dots = '';
		for (var k = 0; k < Math.max(s.online.length, 1); k++) dots += '<i class="on"></i>';
		html('n60-dots', dots);

		/* 内存 */
		set('n60-mempct', s.mpct);
		set('n60-memtot', (s.mtotal / 1073741824).toFixed(2) + ' GB');
		var pg = $('n60-memprog');
		if (pg) {
			pg.className = 'prog' + (s.mpct >= 85 ? ' hot' : s.mpct >= 70 ? ' warn' : '');
			pg.firstChild.style.width = Math.min(100, s.mpct) + '%';
		}
		html('n60-memfoot', '已用 <b class="num">' + (s.mused / 1073741824).toFixed(2) + ' GB</b> · 可用 <b class="num">' + (s.mavail / 1073741824).toFixed(2) + ' GB</b>');

		/* CPU */
		if (s.cpupct == null) { set('n60-cpupct', '—'); set('n60-cpuunit', ''); }
		else { set('n60-cpupct', s.cpupct); set('n60-cpuunit', '%'); }
		set('n60-cpucore', s.cpucores ? (s.cpucores + ' 核') : '—');
		var cg = $('n60-cpuprog');
		if (cg) {
			var cv = s.cpupct == null ? 0 : s.cpupct;
			cg.className = 'prog' + (cv >= 85 ? ' hot' : cv >= 70 ? ' warn' : '');
			cg.firstChild.style.width = Math.min(100, cv) + '%';
		}
		/* 内核版本已在系统卡里，脚注改回 1 分钟负载 */
		html('n60-cpufoot', '1 分钟负载 <b class="num">' + (s.load[0] || '—') + '</b>');

		/* 图 */
		set('n60-devname', s.wdev);
		this.area($('n60-area'), s);

		/* 设备表 */
		var tblCard = $('n60-tblcard');
		if (tblCard) {
			if (s.fallback) tblCard.className = 'card tbl fb';
			else tblCard.className = 'card tbl';
		}
		set('n60-devsub', s.fallback
			? (s.online.length + ' 台在线 · 安装 luci-app-bandix 可看每台流量')
			: (s.online.length + ' 台活跃 · 共 ' + s.devs.length + ' 台有记录'));

		/* 今日每台流量：mac -> 字节（bandix 排行按 mac 给） */
		var rank = {};
		(this.rank || []).forEach(function(x) {
			if (!x || !x.mac) return;
			rank[x.mac] = (x.t_b != null) ? x.t_b : ((x.rx_b || 0) + (x.tx_b || 0));
		});

		var list = s.online.slice(0, 12);
		var sig = s.fallback + '|' + list.length + '|' + list.map(function(x) { return x.mac; }).join(',');
		var tb = $('n60-tbody');

		if (tb && tb.getAttribute('data-sig') === sig && this.rows) {
			/* 成员没变：只改两个数字，不重建 DOM —— 否则每 2 秒整表闪一次 */
			var rm = this.rows;
			list.forEach(function(x) {
				var r = rm[x.mac];
				if (!r) return;
				var rate = (x.t_rx_r || 0) + (x.t_tx_r || 0);
				var rt = rate > 0 ? fmtRate(rate) : '—';
				if (r.rate.textContent !== rt) {
					r.rate.textContent = rt;
					r.rate.className = 'mono r' + (rate > 0 ? ' live' : '');
				}
				var dt = rank[x.mac] != null ? fmtBytes(rank[x.mac]) : '—';
				if (r.day.textContent !== dt) r.day.textContent = dt;
			});
		}
		else {
			var self = this;
			var rows = '';
			list.forEach(function(x) {
				var wf = self.wifiOf(x);
				var kind = x.conn === 'router' ? 'router' : (wf ? 'wifi' : 'wired');
				var acc = x.conn === 'router' ? '本机' : (s.fallback ? '—' : (wf ? freqLabel(x) : '有线'));
				var accCls = wf ? 'w' : 'l';
				var rate = (x.t_rx_r || 0) + (x.t_tx_r || 0);
				var day = rank[x.mac] != null ? fmtBytes(rank[x.mac]) : '—';
				rows += '<tr data-mac="' + esc(x.mac) + '">' +
					'<td class="nm"><span class="dico">' + devIcon(kind) + '</span><span class="t">' +
						esc(x.host || x.mac) + '</span></td>' +
					'<td class="mono ip">' + esc(x.ip4 || '—') + '</td>' +
					(s.fallback
						? '<td class="dim">' + acc + '</td>'
						: '<td><span class="pill-soft ' + accCls + '">' + acc + '</span></td>') +
					'<td class="mono r' + (rate > 0 ? ' live' : '') + '">' +
						(rate > 0 ? fmtRate(rate) : '—') + '</td>' +
					'<td class="mono r">' + day + '</td>' +
				'</tr>';
			});
			if (!rows) rows = '<tr><td colspan="5" class="empty">暂无在线设备</td></tr>';
			html('n60-tbody', rows);
			if (tb) tb.setAttribute('data-sig', sig);

			this.rows = {};
			if (tb) {
				var trs = tb.querySelectorAll('tr[data-mac]');
				for (var q = 0; q < trs.length; q++) {
					var td = trs[q].querySelectorAll('td');
					this.rows[trs[q].getAttribute('data-mac')] = { rate: td[3], day: td[4] };
				}
			}
		}

		/* 系统 */
		var sys = '';
		var kv = function(k, v, cls) {
			sys += '<div class="kv' + (cls ? ' ' + cls : '') + '"><span>' + k + '</span><b>' + esc(v) + '</b></div>';
		};
		kv('主机名', s.hostname);
		kv('型号', s.model || '—');
		kv('架构', s.cpuStr || '—');
		kv('温度', s.tempStr || '—');
		kv('目标平台', s.platform || '—');
		kv('固件版本', s.firmware || '—', 'wide');
		kv('内核版本', s.kernel || '—');
		html('n60-sysinfo', sys);

		if (first) this.bindCopy(root);
	},

	/* 用 getRealtimeStats 已有采样点铺满首屏曲线 */
	seedSeries: function(points) {
		var rx = [], tx = [];
		for (var i = 1; i < points.length; i++) {
			var a = points[i - 1], b = points[i], dt = b[0] - a[0];
			if (dt <= 0 || b[1] < a[1] || b[3] < a[3]) continue;
			rx.push((b[1] - a[1]) / dt);
			tx.push((b[3] - a[3]) / dt);
		}
		this.series.rx = rx.slice(-SERIES_LEN);
		this.series.tx = tx.slice(-SERIES_LEN);
	},

	/* 60 秒迷你波形 */
	spark: function(node) {
		if (!node) return;
		var v = this.series.rx, W = 240, H = 40, n = Math.max(v.length, 2);
		var mx = 1;
		for (var i = 0; i < v.length; i++) if (v[i] > mx) mx = v[i];
		mx *= 1.25;

		var pts = '';
		for (var i = 0; i < v.length; i++) {
			var x = (i / (n - 1)) * W;
			var y = H - 2 - (v[i] / mx) * (H - 8);
			pts += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
		}
		if (!pts) pts = 'M0 ' + (H - 2);

		node.innerHTML = '<svg viewBox="0 0 240 40" preserveAspectRatio="none" ' +
			'style="display:block;width:100%;height:100%">' +
			'<path d="' + pts + ' L' + W + ' ' + H + ' L0 ' + H + ' Z" fill="rgba(18,161,80,.10)"/>' +
			'<path d="' + pts + '" fill="none" stroke="#12a150" stroke-width="1.6" ' +
				'stroke-linejoin="round" stroke-linecap="round"/>' +
			'</svg>';
	},

	/* 大面积图 */
	area: function(node, s) {
		if (!node) return;
		/* 高度跟着实际盒子走：viewBox 用真实高度，preserveAspectRatio=none 只拉宽不压扁，
		   否则 200 的 viewBox 塞进 130px 的盒子，坐标轴文字会被纵向压扁 */
		var W = 720;
		var H = Math.max(110, Math.round(node.clientHeight || 0) || 200);
		var pad = 4;
		var d = this.series.rx, u = this.series.tx, n = d.length;

		var grid = '';
		for (var g = 0; g <= 3; g++) {
			var gy = 8 + g * ((H - 26) / 3);
			grid += '<line x1="0" y1="' + gy + '" x2="' + W + '" y2="' + gy + '" stroke="#eef0f5" stroke-width="1"/>';
		}

		var body = '';

		if (n < 2) {
			body = '<text x="' + (W / 2) + '" y="' + (H / 2) + '" text-anchor="middle" ' +
				'fill="#9aa1af" font-size="12">正在采集数据…</text>';
		}
		else {
			var mx = 1;
			for (var i = 0; i < n; i++) {
				if (d[i] > mx) mx = d[i];
				if (u[i] > mx) mx = u[i];
			}
			mx *= 1.15;

			var line = function(arr) {
				var p = '';
				for (var j = 0; j < arr.length; j++) {
					var x = (j / (arr.length - 1)) * (W - pad * 2) + pad;
					var y = H - 8 - (arr[j] / mx) * (H - 26);
					p += (j ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
				}
				return p;
			};

			var ld = line(d), lu = line(u);
			var yEnd = H - 8 - (d[n - 1] / mx) * (H - 26);

			body = grid +
				'<path d="' + lu + ' L' + (W - pad) + ' ' + H + ' L' + pad + ' ' + H + ' Z" fill="url(#n60gu)"/>' +
				'<path d="' + lu + '" fill="none" stroke="#c9d0e8" stroke-width="1.6" stroke-linejoin="round"/>' +
				'<path d="' + ld + ' L' + (W - pad) + ' ' + H + ' L' + pad + ' ' + H + ' Z" fill="url(#n60gd)"/>' +
				'<path d="' + ld + '" fill="none" stroke="#3b5bfd" stroke-width="2.2" ' +
					'stroke-linejoin="round" stroke-linecap="round"/>' +
				'<circle cx="' + (W - pad) + '" cy="' + yEnd.toFixed(1) + '" r="3.5" ' +
					'fill="#fff" stroke="#3b5bfd" stroke-width="2.2"/>' +
				'<text x="2" y="14" fill="#9aa1af" font-size="10">' + fmtRate(mx) + '</text>' +
				'<text x="2" y="' + (H - 2) + '" fill="#9aa1af" font-size="10">0</text>';
		}

		node.innerHTML = '<svg viewBox="0 0 720 ' + H + '" preserveAspectRatio="none" ' +
			'style="display:block;width:100%;height:100%;overflow:visible">' +
			'<defs>' +
				'<linearGradient id="n60gd" x1="0" y1="0" x2="0" y2="1">' +
					'<stop offset="0" stop-color="#3b5bfd" stop-opacity=".22"/>' +
					'<stop offset="1" stop-color="#3b5bfd" stop-opacity="0"/>' +
				'</linearGradient>' +
				'<linearGradient id="n60gu" x1="0" y1="0" x2="0" y2="1">' +
					'<stop offset="0" stop-color="#b9c2da" stop-opacity=".45"/>' +
					'<stop offset="1" stop-color="#b9c2da" stop-opacity="0"/>' +
				'</linearGradient>' +
			'</defs>' +
			grid + body.replace(grid, '') +
			'</svg>';
	},

	bindCopy: function(root) {
		if (this.copyBound) return;
		this.copyBound = true;

		root.addEventListener('click', function(ev) {
			var t = ev.target.closest ? ev.target.closest('[data-copy]') : null;
			if (!t) return;
			var v = t.getAttribute('data-copy');
			if (!v || v === '—') return;

			var done = function() {
				var old = t.style.color;
				t.style.color = '#12a150';
				setTimeout(function() { t.style.color = old; }, 700);
			};

			if (navigator.clipboard && navigator.clipboard.writeText)
				navigator.clipboard.writeText(v).then(done, done);
			else {
				var ta = document.createElement('textarea');
				ta.value = v; ta.style.position = 'fixed'; ta.style.opacity = '0';
				document.body.appendChild(ta); ta.select();
				try { document.execCommand('copy'); } catch (e) {}
				ta.parentNode.removeChild(ta); done();
			}
		});
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});

/* /proc/stat：返回累加 jiffies，占用率必须靠两次采样相减（单次只能拿累计值） */
function parseCpu(txt) {
	if (!txt) return { total: 0, idle: 0, cores: 0 };
	var lines = String(txt).split('\n'), agg = null, cores = 0;
	for (var i = 0; i < lines.length; i++) {
		var m = /^cpu(\d*)\s+(.+)$/.exec(lines[i]);
		if (!m) continue;
		var f = m[2].replace(/^\s+|\s+$/g, '').split(/\s+/);
		var idle = (parseInt(f[3], 10) || 0) + (parseInt(f[4], 10) || 0);	/* idle + iowait */
		var total = 0;
		for (var j = 0; j < f.length && j < 8; j++) total += parseInt(f[j], 10) || 0;
		if (m[1] === '') agg = { total: total, idle: idle };
		else cores++;
	}
	return { total: agg ? agg.total : 0, idle: agg ? agg.idle : 0, cores: cores };
}

/* ---------- 网络接口识别（不依赖接口命名） ---------- */

/* 从 network.interface dump 里挑出 WAN：
   1) 名字就叫 wan / wwan 的优先
   2) 有默认路由（0.0.0.0/0）的
   3) 最后兜底：唯一一个带 IPv4 地址且不是 lan 的 */
function pickWan(dump) {
	var ifs = (dump && dump.interface) || [], i, x, r;

	for (i = 0; i < ifs.length; i++) {
		x = ifs[i];
		if (x && x.up && (x.interface === 'wan' || x.interface === 'wwan')) return x;
	}
	for (i = 0; i < ifs.length; i++) {
		x = ifs[i];
		if (!x || !x.up || !x.route || isTunnel(x)) continue;
		for (r = 0; r < x.route.length; r++) {
			var rt = x.route[r] || {};
			if (rt.mask === 0 && (rt.target === '0.0.0.0' || rt.target === '::')) return x;
		}
	}
	for (i = 0; i < ifs.length; i++) {
		x = ifs[i];
		if (x && x.up && x.interface !== 'lan' && !isTunnel(x) && x['ipv4-address'] &&
			x['ipv4-address'][0] && x['ipv4-address'][0].address) return x;
	}
	return null;
}

/* 隧道/VPN 接口上的地址不能当成 WAN 公网地址（Tailscale 会给 fd7a::/48 这类 CGNAT 地址） */
function isTunnel(x) {
	if (!x) return true;
	var s = (x.interface || '') + ' ' + (x.l3_device || '') + ' ' + (x.device || '');
	return /(^|\s)(tailscale|tun|tap|wg|ipsec|gre|sit|ovpn|vpn|ppp\d)/i.test(s);
}

/* 挑 WAN 的 IPv6：先 wan 自己，再拿到委派前缀的接口，再名字像 wan 的
   一律跳过隧道接口和 fe80 链路本地地址 */
function pickV6(dump, wan) {
	var ifs = (dump && dump.interface) || [], order = [], i;

	if (wan) order.push(wan);
	for (i = 0; i < ifs.length; i++) {
		var x = ifs[i];
		if (x && x.up && x !== wan && (x['ipv6-prefix'] || []).length) order.push(x);
	}
	for (i = 0; i < ifs.length; i++) {
		var y = ifs[i];
		if (y && y.up && order.indexOf(y) < 0 && /^wan/.test(y.interface || '')) order.push(y);
	}

	for (i = 0; i < order.length; i++) {
		if (isTunnel(order[i])) continue;
		var addrs = order[i]['ipv6-address'] || [];
		for (var j = 0; j < addrs.length; j++) {
			var a = addrs[j] && addrs[j].address;
			if (!a || /^fe80/i.test(a)) continue;
			return addrs[j];
		}
	}
	return null;
}

/* bandix 缺席时的兜底设备表：/proc/net/arp（在线）+ DHCP 租约（名字）
   wanDevs 里的接口名（WAN 及其上游口）上的 ARP 条目要排除，否则会把上游网关当成内网设备 */
function arpDevices(arpTxt, leases, wanDevs) {
	var lname = {}, lip = {};
	var arr = (leases && (leases.dhcp_leases || leases.leases)) || [];
	if (Object.prototype.toString.call(leases) === '[object Array]') arr = leases;
	arr.forEach(function(l) {
		if (!l || !l.macaddr) return;
		var m = String(l.macaddr).toUpperCase();
		if (l.hostname) lname[m] = l.hostname;
		if (l.ipaddr) lip[m] = l.ipaddr;
	});

	var out = [], seen = {}, now = Date.now();
	String(arpTxt || '').split('\n').slice(1).forEach(function(line) {
		var f = line.replace(/^\s+|\s+$/g, '').split(/\s+/);
		if (f.length < 6) return;
		var ip = f[0], flags = parseInt(f[2], 16) || 0, mac = f[3].toUpperCase(), dev = f[5];
		if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) return;
		if (mac === '00:00:00:00:00:00') return;
		if (!(flags & 2)) return;			/* 0x2 = 完整条目（真的解析到 MAC） */
		if (wanDevs && wanDevs[dev]) return;
		if (/^(ppp|wwan|tun|wg|tailscale)/.test(dev)) return;
		if (seen[mac]) return;
		seen[mac] = 1;
		out.push({
			mac: mac,
			host: lname[mac] || '',
			ip4: ip || lip[mac] || '',
			uplink: dev,
			last: now
		});
	});
	return out;
}

function freqLabel(x) {
	var up = (x && x.uplink) || '';
	if (/^(rax|rai)/.test(up)) return 'Wi-Fi 5G';
	if (/^ra\d/.test(up)) return 'Wi-Fi 2.4G';
	return 'Wi-Fi';
}

/* 把接口返回值收成“有效文本”：不是字符串、空的、或者只有一个问号的，都算没取到 */
function txtOf(v) {
	if (typeof v !== 'string') return '';
	var s = v.replace(/^\s+|\s+$/g, '');
	if (!s || s === '?' || s === 'null' || s === 'undefined') return '';
	return s;
}

function esc(s) {
	return String(s == null ? '' : s)
		.replace(/&/g, '&amp;').replace(/</g, '&lt;')
		.replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
