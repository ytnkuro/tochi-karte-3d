// 土地カルテ3D — MVP
// 地理院タイル（標高・地図）とハザードマップポータルのタイルを MapLibre で 3D 表示し、
// クリック地点のハザードをタイルの画素色から判定してカルテに表示する。
(function () {
  'use strict';

  var GSI = 'https://cyberjapandata.gsi.go.jp/xyz/';
  var HZ = 'https://disaportaldata.gsi.go.jp/raster/';

  // ---- 地理院 標高PNG → Terrain-RGB(mapbox形式) 変換 ----
  // 地理院: x = 2^16R + 2^8G + B, x<2^23 → h=0.01x, x=2^23 → 無効, x>2^23 → h=0.01(x-2^24)
  function gsiToMapbox(img) {
    var c = new OffscreenCanvas(256, 256);
    var ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    var im = ctx.getImageData(0, 0, 256, 256);
    var d = im.data;
    for (var i = 0; i < d.length; i += 4) {
      var x = d[i] * 65536 + d[i + 1] * 256 + d[i + 2];
      var h = x === 8388608 ? 0 : x < 8388608 ? x * 0.01 : (x - 16777216) * 0.01;
      var v = Math.round((h + 10000) * 10);
      d[i] = (v >> 16) & 255; d[i + 1] = (v >> 8) & 255; d[i + 2] = v & 255; d[i + 3] = 255;
    }
    ctx.putImageData(im, 0, 0);
    return c.convertToBlob({ type: 'image/png' }).then(function (b) { return b.arrayBuffer(); });
  }
  var seaTile = null; // 海域など標高タイルが無い場所は 0m で埋める
  function flatTile() {
    if (seaTile) return seaTile;
    var c = new OffscreenCanvas(256, 256), ctx = c.getContext('2d');
    ctx.fillStyle = 'rgb(1,134,160)'; // (0+10000)*10 = 100000
    ctx.fillRect(0, 0, 256, 256);
    seaTile = c.convertToBlob({ type: 'image/png' }).then(function (b) { return b.arrayBuffer(); });
    return seaTile;
  }
  maplibregl.addProtocol('gsidem', function (params, abort) {
    var p = params.url.replace('gsidem://', '');
    return fetch(GSI + 'dem_png/' + p + '.png', { signal: abort.signal })
      .then(function (r) { return r.ok ? r.blob().then(createImageBitmap).then(gsiToMapbox) : flatTile(); })
      .then(function (buf) { return { data: buf }; });
  });

  // ---- レイヤー定義 ----
  var BASES = {
    pale: { url: GSI + 'pale/{z}/{x}/{y}.png', max: 18 },
    std: { url: GSI + 'std/{z}/{x}/{y}.png', max: 18 },
    photo: { url: GSI + 'seamlessphoto/{z}/{x}/{y}.jpg', max: 18 }
  };
  var OVERLAYS = {
    lcmfc: { url: GSI + 'lcmfc2/{z}/{x}/{y}.png', min: 11, max: 16, opacity: 0.6 },
    flood: { url: HZ + '01_flood_l2_shinsuishin_data/{z}/{x}/{y}.png', max: 17, opacity: 0.75 },
    hightide: { url: HZ + '03_hightide_l2_shinsuishin_data/{z}/{x}/{y}.png', max: 17, opacity: 0.75 },
    tsunami: { url: HZ + '04_tsunami_newlegend_data/{z}/{x}/{y}.png', max: 17, opacity: 0.75 },
    dosekiryu: { url: HZ + '05_dosekiryukeikaikuiki/{z}/{x}/{y}.png', max: 17, opacity: 0.8 },
    kyukeisha: { url: HZ + '05_kyukeishakeikaikuiki/{z}/{x}/{y}.png', max: 17, opacity: 0.8 },
    jisuberi: { url: HZ + '05_jisuberikeikaikuiki/{z}/{x}/{y}.png', max: 17, opacity: 0.8 }
  };

  // 浸水深ランク（ハザードマップ標準色）
  var DEPTH = [
    { rgb: [247, 245, 169], label: '0.5m未満', note: '床下浸水程度' },
    { rgb: [255, 216, 192], label: '0.5〜3m', note: '1階床上〜1階天井付近まで浸水' },
    { rgb: [255, 183, 183], label: '3〜5m', note: '2階床上まで浸水' },
    { rgb: [255, 145, 145], label: '5〜10m', note: '2階天井〜3階以上まで浸水' },
    { rgb: [242, 133, 201], label: '10〜20m', note: '4階以上まで浸水' },
    { rgb: [220, 122, 220], label: '20m以上', note: '建物がほぼ水没' }
  ];

  // ---- URL 状態 ----
  var qs = new URLSearchParams(location.search);
  var initLayers = qs.get('l') ? qs.get('l').split(',') : null;
  if (initLayers) {
    document.querySelectorAll('[data-layer]').forEach(function (cb) { cb.checked = initLayers.indexOf(cb.dataset.layer) >= 0; });
  }
  if (qs.get('b') && BASES[qs.get('b')]) document.querySelector('input[name=base][value=' + qs.get('b') + ']').checked = true;

  var sources = {
    dem: { type: 'raster-dem', tiles: ['gsidem://{z}/{x}/{y}'], tileSize: 256, maxzoom: 14, encoding: 'mapbox' },
    hs: { type: 'raster-dem', tiles: ['gsidem://{z}/{x}/{y}'], tileSize: 256, maxzoom: 14, encoding: 'mapbox' }
  };
  var layers = [];
  Object.keys(BASES).forEach(function (k) {
    sources['base-' + k] = { type: 'raster', tiles: [BASES[k].url], tileSize: 256, maxzoom: BASES[k].max };
    layers.push({ id: 'base-' + k, type: 'raster', source: 'base-' + k, layout: { visibility: 'none' } });
  });
  layers.push({ id: 'hillshade', type: 'hillshade', source: 'hs', layout: { visibility: 'none' },
    paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#3b4a52' } });
  Object.keys(OVERLAYS).forEach(function (k) {
    var o = OVERLAYS[k];
    sources[k] = { type: 'raster', tiles: [o.url], tileSize: 256, minzoom: o.min || 2, maxzoom: o.max };
    layers.push({ id: k, type: 'raster', source: k, layout: { visibility: 'none' }, paint: { 'raster-opacity': o.opacity } });
  });

  var map = new maplibregl.Map({
    container: 'map',
    hash: 'v',
    center: [139.868, 35.706], zoom: 13, pitch: 60, bearing: -20, maxPitch: 80,
    style: { version: 8, sources: sources, layers: layers, sky: { 'sky-color': '#bcd6e3', 'horizon-color': '#e8eef0', 'fog-color': '#e8eef0' } },
    attributionControl: false
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  map.addControl(new maplibregl.GeolocateControl({}), 'top-right');
  map.addControl(new maplibregl.ScaleControl({}), 'bottom-right');

  var exag = document.getElementById('exag');
  function applyTerrain() {
    map.setTerrain({ source: 'dem', exaggeration: +exag.value });
    document.getElementById('exagv').textContent = exag.value + '×';
  }
  function applyLayers() {
    var base = document.querySelector('input[name=base]:checked').value;
    Object.keys(BASES).forEach(function (k) { map.setLayoutProperty('base-' + k, 'visibility', k === base ? 'visible' : 'none'); });
    document.querySelectorAll('[data-layer]').forEach(function (cb) {
      map.setLayoutProperty(cb.dataset.layer, 'visibility', cb.checked ? 'visible' : 'none');
    });
    syncUrl();
  }
  map.on('load', function () {
    applyTerrain();
    applyLayers();
    if (qs.get('p')) {
      var ll = qs.get('p').split(',').map(Number);
      if (ll.length === 2 && isFinite(ll[0]) && isFinite(ll[1])) select(ll[0], ll[1], false);
    }
  });
  exag.addEventListener('input', applyTerrain);
  document.getElementById('layers').addEventListener('change', applyLayers);
  document.querySelector('#layers h2').addEventListener('click', function () { this.parentNode.classList.toggle('open'); });

  var selected = null;
  function syncUrl() {
    var p = new URLSearchParams();
    if (selected) p.set('p', selected[0].toFixed(5) + ',' + selected[1].toFixed(5));
    p.set('b', document.querySelector('input[name=base]:checked').value);
    p.set('l', Array.prototype.filter.call(document.querySelectorAll('[data-layer]'), function (c) { return c.checked; })
      .map(function (c) { return c.dataset.layer; }).join(','));
    history.replaceState(null, '', '?' + p.toString() + location.hash);
  }

  // ---- 地点のハザードをタイル画素から読む ----
  function tilePixel(tpl, lat, lon, z) {
    var n = Math.pow(2, z);
    var fx = (lon + 180) / 360 * n;
    var r = lat * Math.PI / 180;
    var fy = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n;
    var x = Math.floor(fx), y = Math.floor(fy);
    var px = Math.floor((fx - x) * 256), py = Math.floor((fy - y) * 256);
    var url = tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    return fetch(url).then(function (res) {
      if (!res.ok) return null; // タイル無し = 区域外
      return res.blob().then(createImageBitmap).then(function (bmp) {
        var c = new OffscreenCanvas(256, 256), ctx = c.getContext('2d');
        ctx.drawImage(bmp, 0, 0);
        var d = ctx.getImageData(px, py, 1, 1).data;
        return d[3] < 16 ? null : [d[0], d[1], d[2]];
      });
    }).catch(function () { return undefined; }); // undefined = 取得失敗
  }
  function depthRank(rgb) {
    var best = -1, bd = 1e9;
    DEPTH.forEach(function (r, i) {
      var dd = Math.pow(r.rgb[0] - rgb[0], 2) + Math.pow(r.rgb[1] - rgb[1], 2) + Math.pow(r.rgb[2] - rgb[2], 2);
      if (dd < bd) { bd = dd; best = i; }
    });
    return bd < 2500 ? best : -1;
  }

  function getJSON(url) { return fetch(url).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }); }

  var marker = new maplibregl.Marker({ color: '#b4532a' });
  var karte = document.getElementById('karte');
  var items = document.getElementById('items');

  function row(title, html) {
    var d = document.createElement('div');
    d.innerHTML = '<dt>' + title + '</dt><dd>' + html + '</dd>';
    items.appendChild(d);
    return d.querySelector('dd');
  }
  function depthHtml(rgb, empty) {
    if (rgb === undefined) return '取得できませんでした';
    if (rgb === null) return empty;
    var k = depthRank(rgb);
    if (k < 0) return '想定区域内（ランク判別不可）';
    var r = DEPTH[k];
    return '<span class="sw" style="background:rgb(' + r.rgb.join(',') + ')"></span>' + r.label + '<small>' + r.note + '</small>';
  }
  function zoneHtml(results) {
    var names = ['土石流', '急傾斜地の崩壊', '地すべり'];
    if (results.every(function (v) { return v === undefined; })) return '取得できませんでした';
    var hits = names.filter(function (_, i) { return results[i]; });
    return hits.length ? '<b>警戒区域内</b>：' + hits.join('・') + '<small>色の濃い区域は特別警戒区域の可能性があります。レイヤーで確認してください</small>'
      : '警戒区域に含まれていません';
  }

  function select(lat, lon, fly) {
    selected = [lat, lon];
    marker.setLngLat([lon, lat]).addTo(map);
    if (fly) map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 15), pitch: 60, essential: true });
    syncUrl();
    karte.hidden = false;
    items.innerHTML = '';
    var addr = document.getElementById('addr');
    addr.textContent = lat.toFixed(5) + ', ' + lon.toFixed(5);

    getJSON('https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=' + lat + '&lon=' + lon).then(function (j) {
      if (j && j.results) addr.textContent = j.results.lv01Nm + '（' + lat.toFixed(5) + ', ' + lon.toFixed(5) + '）';
    });

    var elev = row('標高', '…');
    getJSON('https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=' + lon + '&lat=' + lat + '&outtype=JSON').then(function (j) {
      elev.innerHTML = j && typeof j.elevation === 'number' ? j.elevation.toFixed(1) + ' m<small>' + j.hsrc + '</small>' : '取得できませんでした';
    });

    var empty = '想定区域に含まれていません<small>想定の対象外の川・内水氾濫はありえます</small>';
    var flood = row('洪水（想定最大規模）', '…');
    tilePixel(OVERLAYS.flood.url, lat, lon, 17).then(function (v) { flood.innerHTML = depthHtml(v, empty); });
    var tide = row('高潮', '…');
    tilePixel(OVERLAYS.hightide.url, lat, lon, 17).then(function (v) { tide.innerHTML = depthHtml(v, empty); });
    var tsunami = row('津波', '…');
    tilePixel(OVERLAYS.tsunami.url, lat, lon, 17).then(function (v) { tsunami.innerHTML = depthHtml(v, empty); });
    var slide = row('土砂災害', '…');
    Promise.all(['dosekiryu', 'kyukeisha', 'jisuberi'].map(function (k) { return tilePixel(OVERLAYS[k].url, lat, lon, 17); }))
      .then(function (r) { slide.innerHTML = zoneHtml(r); });

    row('リンク', '<a target="_blank" rel="noopener" href="https://disaportal.gsi.go.jp/hazardmap/maps/index.html?ll=' + lat + ',' + lon + '&z=16">重ねるハザードマップで開く</a>' +
      '<small><a target="_blank" rel="noopener" href="https://disaportal.gsi.go.jp/hazardmap/">わがまちハザードマップ（市町村）</a></small>');
  }

  map.on('click', function (e) { select(e.lngLat.lat, e.lngLat.lng, false); });
  document.getElementById('close').addEventListener('click', function () {
    karte.hidden = true; marker.remove(); selected = null; syncUrl();
  });
  document.getElementById('share').addEventListener('click', function () {
    var b = this;
    navigator.clipboard.writeText(location.href).then(function () { b.textContent = 'コピーしました'; }, function () { b.textContent = location.href; });
    setTimeout(function () { b.textContent = 'このカルテのURLをコピー'; }, 2000);
  });

  // ---- 住所検索（地理院 地名検索API）----
  var form = document.getElementById('search'), q = document.getElementById('q'), list = document.getElementById('results');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!q.value.trim()) return;
    getJSON('https://msearch.gsi.go.jp/address-search/AddressSearch?q=' + encodeURIComponent(q.value.trim())).then(function (res) {
      list.innerHTML = '';
      (res || []).slice(0, 10).forEach(function (f) {
        var li = document.createElement('li');
        li.tabIndex = 0;
        li.textContent = f.properties.title;
        li.addEventListener('click', function () {
          list.hidden = true; q.value = f.properties.title;
          select(f.geometry.coordinates[1], f.geometry.coordinates[0], true);
        });
        li.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') li.click(); });
        list.appendChild(li);
      });
      if (!list.children.length) list.innerHTML = '<li>見つかりませんでした</li>';
      list.hidden = false;
    });
  });
  document.addEventListener('click', function (e) { if (!form.contains(e.target)) list.hidden = true; });
})();
