// ─── Character -> signature weapon mapping ─────────────────────────────────
//
// Single source of truth for "is this character using their signature
// weapon?" - deliberately a plain, hand-maintained table so it's trivial to
// extend when a new character/weapon releases: add ONE line below, nothing
// else. Keys are character names (matched case/punctuation-insensitively via
// normalizeName), values are the exact in-game weapon names as the Enka API
// reports them.

const SIGNATURE_WEAPONS = {
    // Seed list of well-established pairs. Keep values spelling-matched to
    // the English in-game weapon names.
    'odette': 'Whitelake Frostfeather',
    'hu tao': 'Staff of Homa',
    'kamisato ayaka': 'Mistsplitter Reforged',
    'raiden shogun': 'Engulfing Lightning',
    'xiao': 'Primordial Jade Winged-Spear',
    'arataki itto': 'Redhorn Stonethresher',
    'nahida': 'A Thousand Floating Dreams',
    'alhaitham': 'Light of Foliar Incision',
    'neuvillette': 'Tome of the Eternal Flow',
    'furina': 'Splendor of Tranquil Waters',
};

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
