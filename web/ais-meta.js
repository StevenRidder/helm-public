// HelmAisMeta — AIS code lookups for the target card: flag (from MMSI MID),
// navigational-status label+tone+style, ship-type category, and ROT formatting.
// Pure data + helpers, no deps. Lets the popup show country/type/status the moment
// the engine forwards the (already-decoded) codes — and the flag works frontend-only today.
(function (global) {
  'use strict';
  // ITU Maritime Identification Digits (MMSI MID) -> ISO-3166 alpha-2 country code.
  var MID = {
    '201':'AL','202':'AD','203':'AT','204':'PT','205':'BE','206':'BY','207':'BG','208':'VA','209':'CY',
    '210':'CY','211':'DE','212':'CY','213':'GE','214':'MD','215':'MT','216':'AM','218':'DE','219':'DK',
    '220':'DK','224':'ES','225':'ES','226':'FR','227':'FR','228':'FR','229':'MT','230':'FI','231':'FO',
    '232':'GB','233':'GB','234':'GB','235':'GB','236':'GI','237':'GR','238':'HR','239':'GR','240':'GR',
    '241':'GR','242':'MA','243':'HU','244':'NL','245':'NL','246':'NL','247':'IT','248':'MT','249':'MT',
    '250':'IE','251':'IS','252':'LI','253':'LU','254':'MC','255':'PT','256':'MT','257':'NO','258':'NO',
    '259':'NO','261':'PL','262':'ME','263':'PT','264':'RO','265':'SE','266':'SE','267':'SK','268':'SM',
    '269':'CH','270':'CZ','271':'TR','272':'UA','273':'RU','274':'MK','275':'LV','276':'EE','277':'LT',
    '278':'SI','279':'RS',
    '301':'AI','303':'US','304':'AG','305':'AG','306':'CW','307':'AW','308':'BS','309':'BS','310':'BM',
    '311':'BS','312':'BZ','314':'BB','316':'CA','319':'KY','321':'CR','323':'CU','325':'DM','327':'DO',
    '329':'GP','330':'GD','331':'GL','332':'GT','334':'HN','336':'HT','338':'US','339':'JM','341':'KN',
    '343':'LC','345':'MX','347':'MQ','348':'MS','350':'NI','351':'PA','352':'PA','353':'PA','354':'PA',
    '355':'PA','356':'PA','357':'PA','358':'PR','359':'SV','361':'PM','362':'TT','364':'TC','366':'US',
    '367':'US','368':'US','369':'US','370':'PA','371':'PA','372':'PA','373':'PA','374':'PA','375':'VC',
    '376':'VC','377':'VC','378':'VG','379':'VI',
    '401':'AF','403':'SA','405':'BD','408':'BH','410':'BT','412':'CN','413':'CN','414':'CN','416':'TW',
    '417':'LK','419':'IN','422':'IR','423':'AZ','425':'IQ','428':'IL','431':'JP','432':'JP','434':'TM',
    '436':'KZ','437':'UZ','438':'JO','440':'KR','441':'KR','443':'PS','445':'KP','447':'KW','450':'LB',
    '451':'KG','453':'MO','455':'MV','457':'MN','459':'NP','461':'OM','463':'PK','466':'QA','468':'SY',
    '470':'AE','471':'AE','472':'TJ','473':'YE','475':'YE','477':'HK','478':'BA',
    '501':'TF','503':'AU','506':'MM','508':'BN','510':'FM','511':'PW','512':'NZ','514':'KH','515':'KH',
    '516':'CX','518':'CK','520':'FJ','523':'CC','525':'ID','529':'KI','531':'LA','533':'MY','536':'MP',
    '538':'MH','540':'NC','542':'NU','544':'NR','546':'PF','548':'PH','553':'PG','555':'PN','557':'SB',
    '559':'AS','561':'WS','563':'SG','564':'SG','565':'SG','566':'SG','567':'TH','570':'TO','572':'TV',
    '574':'VN','576':'VU','577':'VU','578':'WF',
    '601':'ZA','603':'AO','605':'DZ','607':'TF','608':'SH','609':'BI','610':'BJ','611':'BW','612':'CF',
    '613':'CM','615':'CG','616':'KM','617':'CV','618':'TF','619':'CI','620':'KM','621':'DJ','622':'EG',
    '624':'ET','625':'ER','626':'GA','627':'GH','629':'GM','630':'GW','631':'GQ','632':'GN','633':'BF',
    '634':'KE','635':'TF','636':'LR','637':'LR','638':'SS','642':'LY','644':'LS','645':'MU','647':'MG',
    '649':'ML','650':'MZ','654':'MR','655':'MW','656':'NE','657':'NG','659':'NA','660':'RE','661':'RW',
    '662':'SD','663':'SN','664':'SC','665':'SH','666':'SO','667':'SL','668':'ST','669':'SZ','670':'TD',
    '671':'TG','672':'TN','674':'TZ','675':'UG','676':'CD','677':'TZ','678':'ZM','679':'ZW',
    '701':'AR','710':'BR','720':'BO','725':'CL','730':'CO','735':'EC','740':'FK','745':'GF','750':'GY',
    '755':'PY','760':'PE','765':'SR','770':'UY','775':'VE'
  };
  function midOf(mmsi) {
    var s = String(mmsi == null ? '' : mmsi); if (s.length !== 9) return null;
    if (s.charAt(0) === '8') return s.substr(1, 3);                                  // handheld VHF
    var p3 = s.substr(0, 3), p2 = s.substr(0, 2);
    if (p3 === '111') return s.substr(3, 3);                                          // SAR aircraft
    if (p3 === '970' || p3 === '972' || p3 === '974') return null;                    // SART / MOB / EPIRB
    if (p2 === '99' || p2 === '98' || p2 === '00') return s.substr(2, 3);             // AtoN / craft-assoc / coast stn
    if (s.charAt(0) === '0') return s.substr(1, 3);                                   // group station
    return p3;                                                                        // standard ship
  }
  function flag(mmsi) {
    var cc = MID[midOf(mmsi)]; if (!cc) return '';
    return cc.replace(/./g, function (c) { return String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65); });
  }
  // AIS navigational status (Msg 1/2/3) -> label + tone.
  var NAV = {
    0: { label: 'Under way (engine)', tone: 'go' }, 1: { label: 'At anchor', tone: 'mut' },
    2: { label: 'Not under command', tone: 'bad' }, 3: { label: 'Restricted manoeuvr.', tone: 'bad' },
    4: { label: 'Constrained by draught', tone: 'warn' }, 5: { label: 'Moored', tone: 'mut' },
    6: { label: 'Aground', tone: 'bad' }, 7: { label: 'Fishing', tone: 'warn' },
    8: { label: 'Under way sailing', tone: 'go' }, 9: { label: 'High-speed craft', tone: 'go' },
    10: { label: 'WIG', tone: 'go' }, 11: { label: 'Towing astern', tone: 'warn' },
    12: { label: 'Pushing / towing', tone: 'warn' }, 14: { label: 'AIS-SART / MOB / EPIRB', tone: 'bad' },
    // AtoN state (OpenCPN nav-status 16–21): virtual (electronic) vs real (physical) aid, and on/off position.
    16: { label: 'Virtual AtoN', tone: 'mut' }, 17: { label: 'Virtual AtoN · on position', tone: 'mut' },
    18: { label: 'Virtual AtoN · OFF POSITION', tone: 'warn' }, 19: { label: 'Real AtoN', tone: 'mut' },
    20: { label: 'Real AtoN · on position', tone: 'mut' }, 21: { label: 'Real AtoN · OFF POSITION', tone: 'warn' }
  };
  function navStatus(code) { return code == null ? null : (NAV[+code] || null); }
  var STYLE = {
    go:   { bg: 'rgba(80,160,255,.18)',  fg: '#7db8ff', icon: '▸' },   // ▸
    mut:  { bg: 'rgba(150,160,170,.18)', fg: '#b9c2cc', icon: '⚓' },   // ⚓
    warn: { bg: 'rgba(245,196,81,.18)',  fg: '#f5c451', icon: '⚠' },   // ⚠
    bad:  { bg: 'rgba(230,80,80,.22)',   fg: '#ff6a6a', icon: '⛔' }    // ⛔
  };
  function navStyle(tone) { return STYLE[tone] || STYLE.mut; }
  // AIS ship type (Msg 5 / 24) -> category string.
  var TYPE = { 30:'Fishing',31:'Towing',32:'Towing (long)',33:'Dredging',34:'Diving ops',35:'Military',
    36:'Sailing',37:'Pleasure craft',50:'Pilot',51:'Search & rescue',52:'Tug',53:'Port tender',
    54:'Anti-pollution',55:'Law enforcement',58:'Medical',59:'Non-combatant' };
  function shipType(code) {
    var c = +code; if (!c) return null;
    return TYPE[c] || ({ 2:'WIG', 4:'High-speed craft', 6:'Passenger', 7:'Cargo', 8:'Tanker', 9:'Other' })[Math.floor(c / 10)] || null;
  }
  // Rate of turn (deg/min, signed) -> short label.
  function rot(r) {
    if (r == null) return null; var n = +r; if (!isFinite(n)) return null;
    if (Math.abs(n) < 1) return 'steady';
    return (n > 0 ? '↻ ' : '↺ ') + Math.abs(Math.round(n)) + '°/min';
  }

  // ---- AIS symbology classification (AIS-2) ----
  // Each target carries a `class` code (mirrors index.html's AIS_CLASS: 0 Class A, 1 Class B,
  // 2 AtoN, 3 Base station, 5 DSC, 6 SART, 7 ARPA, 9 Meteo). symbolKind() picks ONE symbol kind
  // per target so the map draws it exactly once; a target unheard past LOST_SEC is "lost" (the
  // OpenCPN cross-out) regardless of class — except a SART/MOB, where distress trumps lost.
  var LOST_SEC = 360;                          // 6 min unheard -> lost cross-out (OpenCPN default)

  // Returns 'classA' | 'classB' | 'aton' | 'base' | 'sart' | 'lost'. class is authoritative;
  // shipType is only used to guess A vs B when the engine hasn't sent a class field yet.
  function symbolKind(t) {
    if (!t) return 'classB';
    var cls = t.class == null ? null : +t.class;
    var mmsi = String(t.mmsi == null ? '' : t.mmsi);
    var pfx3 = mmsi.substr(0, 3);
    // SART / MOB / EPIRB — class 6, nav status 14, or the 970/972/974 MMSI prefix. Highest priority.
    if (cls === 6 || +t.navStatus === 14 || pfx3 === '970' || pfx3 === '972' || pfx3 === '974') return 'sart';
    if (cls === 9) return 'meteo';                                  // AIS-11: meteo BEFORE aton — class is authoritative; met MMSIs can fall in the 99x AtoN range
    if (cls === 2 || mmsi.substr(0, 2) === '99') return 'aton';     // AtoN (also 99xxxxxxx MMSI)
    if (cls === 3 || mmsi.substr(0, 2) === '00') return 'base';     // base station (00xxxxxxx MMSI)
    if (isLost(t)) return 'lost';
    if (cls === 1) return 'classB';
    if (cls === 0) return 'classA';
    var st = +t.shipType || +t.type;                                // no class yet -> infer from type
    if (st === 36 || st === 37) return 'classB';                    // sailing / pleasure -> usually Class B
    return 'classA';
  }
  function isLost(t) { return !!(t && t.ageSec != null && +t.ageSec > LOST_SEC); }

  // Glyph + short label per kind. Plain Unicode so they render in the bundled Noto Sans font
  // (no sprite assets needed). `rot` = whether the glyph rotates with the target's COG.
  var SYMBOL = {
    classA: { glyph: '▲', label: 'Class A',  rot: true  },
    classB: { glyph: '▲', label: 'Class B',  rot: true  },
    aton:   { glyph: '◆', label: 'AtoN',     rot: false },
    base:   { glyph: '◉', label: 'Base stn', rot: false },
    sart:   { glyph: '✚', label: 'SART/MOB', rot: false },
    meteo:  { glyph: '◈', label: 'Weather',  rot: false },
    lost:   { glyph: '▲', label: 'Lost',     rot: true  }
  };
  function symbol(kind) { return SYMBOL[kind] || SYMBOL.classB; }

  // ---- moored / slow-target suppression (AIS-6, mirrors OpenCPN g_ShowMoored_Kts) ----
  // A target is suppressible when it's essentially stationary: SOG at/below the threshold AND
  // either moored/at-anchor by nav status, or no nav status at all (the common sim/Class-B case).
  // SAFETY: never suppress a SART/MOB or anything actively dangerous — callers must OR-guard that.
  function isMooredSlow(t, kts) {
    if (!t) return false;
    var thr = (kts == null ? 0.5 : +kts);
    var sog = +t.sog;
    if (!isFinite(sog) || sog > thr) return false;             // moving -> always shown
    var ns = t.navStatus == null ? null : +t.navStatus;
    return ns == null || ns === 1 || ns === 5 || ns === 15;    // at-anchor (1) / moored (5) / not-defined (15, the AIS default — most Class-B + unset Class-A)
  }

  global.HelmAisMeta = {
    flag: flag, midOf: midOf, navStatus: navStatus, navStyle: navStyle,
    shipType: shipType, rot: rot,
    symbolKind: symbolKind, symbol: symbol, isLost: isLost, LOST_SEC: LOST_SEC,
    isMooredSlow: isMooredSlow
  };
})(typeof window !== 'undefined' ? window : this);
