const test = require('node:test');
const assert = require('node:assert');
const Path = require('path');
const Fs = require('fs');

/* Map.js reaches the Discord client through `require('../../index.ts')`, which
   boots the whole bot on import. Seed the module cache with a stub. */
const indexPath = Path.join(__dirname, '..', '..', 'index.ts');
const clientStub = {
    client: {
        intlGet: (guildId, id) => id,
        rustplusMaps: {}
    }
};
require.cache[indexPath] = {
    id: indexPath, filename: indexPath, path: Path.dirname(indexPath),
    loaded: true, children: [], paths: [], exports: clientStub
};

const { Jimp } = require('jimp');
const MapStructure = require('./Map.js');

const GUILD_ID = 'jimp-migration-test';
const MAP_SIZE = 4000;
const IMAGE_SIZE = 500;
const MAPS_DIR = Path.join(__dirname, '..', '..', 'maps');
const CLEAN_PATH = Path.join(MAPS_DIR, `${GUILD_ID}_map_clean.png`);
const FULL_PATH = Path.join(MAPS_DIR, `${GUILD_ID}_map_full.png`);

/* The Rust+ marker type ids Map.js looks up via getMarkerImageMetaByType. */
const TYPE_CARGO_SHIP = 5;

function makeRustPlus(markers) {
    return {
        guildId: GUILD_ID,
        info: { mapSize: MAP_SIZE },
        cargoShipTracers: {},
        patrolHelicopterTracers: {},
        mapMarkers: { types: { CargoShip: TYPE_CARGO_SHIP } },
        log() { },
        async isResponseValid() { return true; },
        async getMapMarkersAsync() { return { mapMarkers: { markers } }; }
    };
}

async function makeBaseImageBuffer() {
    const image = new Jimp({ width: IMAGE_SIZE, height: IMAGE_SIZE, color: 0x203040ff });
    return await image.getBuffer('image/png');
}

async function buildMap(monuments, markers) {
    if (!Fs.existsSync(MAPS_DIR)) Fs.mkdirSync(MAPS_DIR, { recursive: true });

    const map = new MapStructure({
        width: IMAGE_SIZE,
        height: IMAGE_SIZE,
        jpgImage: await makeBaseImageBuffer(),
        oceanMargin: 0,
        monuments: monuments,
        background: null
    }, makeRustPlus(markers));

    /* The constructor kicks off an un-awaited resetImageAndMeta(); writeMap
       runs it again and does await, so the render below is deterministic. */
    return map;
}

/* Count pixels that differ from the flat background the map started as. Both
   the monument text and the marker sprites are drawn inside `try { } catch {}`
   blocks in Map.js, so a broken jimp call would silently produce a clean map
   rather than throwing — comparing pixels is the only way to prove the draw
   actually happened. */
async function changedPixelCount(path) {
    const image = await Jimp.read(path);
    let changed = 0;
    for (let x = 0; x < image.width; x += 2) {
        for (let y = 0; y < image.height; y += 2) {
            if (image.getPixelColor(x, y) !== 0x203040ff) changed += 1;
        }
    }
    return changed;
}

test.after(async () => {
    /* The Map constructor kicks off resetImageAndMeta() without awaiting it,
       so a render can still be reading the clean map after the test that
       started it returned. Let those settle before deleting the files, or the
       stray read rejects against a file we just removed. */
    await new Promise(resolve => setTimeout(resolve, 500));

    for (const p of [CLEAN_PATH, FULL_PATH]) {
        try { Fs.unlinkSync(p); } catch { /* never created */ }
    }
});

test('the map renders monument labels onto the image', async () => {
    const map = await buildMap([{ token: 'launch_site_display_name', x: 2000, y: 2000 }], []);

    await map.writeMap(false, true);

    assert.ok(Fs.existsSync(FULL_PATH), 'the rendered map should have been written');
    assert.ok(await changedPixelCount(FULL_PATH) > 0,
        'monument text should have been printed onto the map');
});

test('the map composites event markers onto the image', async () => {
    const map = await buildMap([], [
        { id: 1, type: TYPE_CARGO_SHIP, x: 2000, y: 2000, rotation: 45 }
    ]);

    await map.writeMap(true, false);

    assert.ok(Fs.existsSync(FULL_PATH), 'the rendered map should have been written');
    assert.ok(await changedPixelCount(FULL_PATH) > 0,
        'the cargo ship marker should have been composited onto the map');
});

test('marker images are loaded and resized to their configured size', async () => {
    const map = await buildMap([], []);

    await map.setupMapMarkerImages();

    const cargo = map.mapMarkerImageMeta.cargo;
    assert.ok(cargo.jimp, 'the cargo marker image should have been read');
    assert.strictEqual(cargo.jimp.width, cargo.size);
    assert.strictEqual(cargo.jimp.height, cargo.size);
});

test('the bitmap font loads for monument labels', async () => {
    const map = await buildMap([], []);

    await map.setupFont();

    assert.ok(map.font, 'the .fnt font should have loaded');
    assert.ok(map.font.chars, 'the loaded font should expose its glyphs');
});
