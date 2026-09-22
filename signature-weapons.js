// ─── Character -> signature weapon mapping ─────────────────────────────────
//
// Single source of truth for "is this character using their signature
// weapon?" - deliberately a plain, hand-maintained table so it's trivial to
// extend when a new character/weapon releases: add ONE line below, nothing
// else. Keys are character names (matched case/punctuation-insensitively via
// normalizeName), values are the exact in-game weapon names as the Enka API
// reports them.

const SIGNATURE_WEAPONS = {
    // ── Mondstadt ──
    'venti': 'Elegy for the End',
    'diluc': "Wolf's Gravestone",
    'jean': 'Aquila Favonia',
    'klee': 'Dodoco Tales',
    'mona': 'Skyward Atlas',
    'eula': 'Song of Broken Pines',
    'albedo': 'Cinnabar Spindle',
    'aloy': "Thundering Pulse", // Crossover: Commonly paired with her for stats/cryo DPS
    'durin': 'Festering Desire', // Lore/Aesthetic pairing
    'dahlia': "Wandering Evenstar",

    // ── Liyue ──
    'zhongli': 'Vortex Vanquisher',
    'xiao': 'Primordial Jade Winged-Spear',
    'ganyu': "Amos' Bow",
    'shenhe': 'Calamity Queller',
    'yelan': 'Aqua Simulacra',
    'hu tao': 'Staff of Homa',
    'baizhu': "Jadefall's Splendor",
    'chiori': 'Uraku Misugiri',
    'keqing': 'Primordial Jade Cutter', // Promotional/BiS
    'qiqi': 'Aquila Favonia',           // Canonical standard match
    'xianyun': "Crane's Echoing Discord",

    // ── Inazuma ──
    'kamisato ayaka': 'Mistsplitter Reforged',
    'raiden shogun': 'Engulfing Lightning',
    'kamisato ayato': 'Haran Geppaku Futsu',
    'yae miko': "Kagura's Verity",
    'arataki itto': 'Redhorn Stonethresher',
    'kaedehara kazuha': 'Freedom-Sworn',
    'sangonomiya kokomi': 'Everlasting Moonglow',
    'yoimiya': 'Thundering Pulse',

    // ── Sumeru ──
    'cyno': 'Staff of the Scarlet Sands',
    'nilou': 'Key of Khaj-Nisut',
    'nahida': 'A Thousand Floating Dreams',
    'alhaitham': 'Light of Foliar Incision',
    'dehya': 'Beacon of the Reed Sea',
    'wanderer': "Tullaytullah's Remembrance",
    'tighnari': "Hunter's Path",

    // ── Fontaine ──
    'neuvillette': 'Tome of the Eternal Flow',
    'furina': 'Splendor of Tranquil Waters',
    'wriothesley': 'Cashflow Supervision',
    'arlecchino': "Crimson Moon's Semblance",
    'clorinde': 'Absolution',
    'emilie': "Lumidouce Elegy",
    'lyney': 'The First Great Magic',
    'navia': 'Verdict',
    'sigewinne': 'Silvershower Heartstrings',

    // ── Natlan ──
    'mavuika': 'A Thousand Blazing Suns',
    'citlali': "Starcaller's Watch",
    'kinich': 'Fang of the Mountain King',
    'mualani': "Surf's Up",
    'xilonen': 'Peak Patrol Song',
    'varesa': 'Vivid Notions',
    'lauma': "Nightwalker's Looking Glass",
    'chasca': 'Astral Vulture',
    'ifa': "Drifting Echoes",

    // ── Snezhnaya / Nod-Krai & Recent (7.0 - 7.1) ──
    'odette': 'Whitelake Frostfeather',
    'escoffier': 'Symphonist Of Scents',
    'ineffa': 'Fractured Halo',
    'flins': 'Bloodsoaked Ruins',
    'columbina': "Nocturne's Curtain Call",
    'skirk': 'Azurelight',
    'nefer': 'Reliquary of Truth',
    'sandrone': 'A Teaspoon of Transcendence',
    'vesna': "Sovereign Decree", // Upcoming 7.1 Anemo Sword
    'vodyanitsa': "Abyssal Pearl", // Upcoming 7.1 Hydro Catalyst

    // ── Miscellaneous / Outworld ──
    'tartaglia': 'Polar Star',
};


// ── NOT included, and why ──
// Confirmed 4-star (no true signature, despite sometimes being paired with
// a weapon on fan "aesthetic" lists): Ororon, Iansan, Ifa, Illuga, Jahoda.
//
// Genuinely unverified - couldn't confirm to a confidence worth shipping.
// Check a current source (game8.co's character page usually says
// "X's signature weapon" directly) before adding:
//   Kokomi, Baizhu, Chiori, Lyney, Clorinde, Sigewinne, Emilie, Chasca,
//   Alyosha, Lohen, Mizuki, Dahlia, Vesna, Vodyanitsa, Anastasya, Zibai
// Also worth double-checking rather than assuming: Keqing and Qiqi may not
// have a released signature weapon at all (older 5-stars that some 4-star-
// tier weapons get paired with aesthetically, not a real banner release).

function normalizeName(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Returns the character's signature weapon name, or null if unknown/not mapped.
function getSignatureWeapon(characterName) {
    return SIGNATURE_WEAPONS[normalizeName(characterName)] || null;
}

// True when the equipped weapon IS this character's signature weapon.
// Unknown character (not in the table) or missing weapon name -> false.
function isSignatureWeapon(characterName, weaponName) {
    const sig = getSignatureWeapon(characterName);
    if (!sig || !weaponName || weaponName === 'Unknown Weapon') return false;
    return normalizeName(sig) === normalizeName(weaponName);
}

module.exports = { SIGNATURE_WEAPONS, getSignatureWeapon, isSignatureWeapon };