/*
    Slim runtime shell for RustLabs data. The big lookup-command surface
    (craft/decay/despawn/recycle/research/stack/upkeep/durability/smelting)
    used to live here; those commands and their data files were removed
    because the team uses rustlabs.com directly for that information.

    What remains:
      - Closest-name lookups for "building blocks" and "other" categories,
        used by the /item command to resolve free-text item names.
      - getRecycleDataFromArray, used by the storage-monitor Discord button
        to preview what a box's contents would recycle into.
*/

const Items = require('./Items');
const RustlabsBuildingBlocks = require('../staticFiles/rustlabsBuildingBlocks.json');
const RustlabsOther = require('../staticFiles/rustlabsOther.json');
const RecycleData = require('../staticFiles/rustlabsRecycleData.json');
const Utils = require('../util/utils.js');

const IGNORED_RECYCLE_ITEMS = [
    '-946369541' /* Low Grade Fuel */
];

class RustLabs {
    constructor() {
        this._items = new Items();
        this._recycleData = RecycleData;
        this._rustlabsBuildingBlocks = RustlabsBuildingBlocks;
        this._rustlabsOther = RustlabsOther;
        this._buildingBlocks = Object.keys(this.rustlabsBuildingBlocks);
        this._other = Object.keys(this.rustlabsOther);
    }

    get items() { return this._items; }
    get recycleData() { return this._recycleData; }
    get rustlabsBuildingBlocks() { return this._rustlabsBuildingBlocks; }
    get rustlabsOther() { return this._rustlabsOther; }
    get buildingBlocks() { return this._buildingBlocks; }
    get other() { return this._other; }

    getClosestBuildingBlockNameByName(name) {
        return Utils.findClosestString(name, this.buildingBlocks) || null;
    }

    getClosestOtherNameByName(name) {
        return Utils.findClosestString(name, this.other) || null;
    }

    hasRecycleDetails(itemId) {
        return Object.prototype.hasOwnProperty.call(this.recycleData, itemId);
    }

    /* Expand an item list through one or more recycler types until nothing
       can be reduced further. Used by the storage-monitor recycle preview. */
    getRecycleDataFromArray(items) {
        const mergedItems = [];
        for (const item of items) {
            const itemId = (typeof (item.itemId) === 'string') ? item.itemId : item.itemId.toString();
            const found = mergedItems.find(e => e.itemId === itemId && e.itemIsBlueprint === item.itemIsBlueprint);
            if (found === undefined) {
                mergedItems.push({ itemId, quantity: item.quantity, itemIsBlueprint: item.itemIsBlueprint });
            }
            else {
                found.quantity += item.quantity;
            }
        }
        items = mergedItems.slice();

        const recycleData = { recycler: [], shredder: [], 'safe-zone-recycler': [] };

        for (const recyclerType in recycleData) {
            let recycledItems = items.slice();
            while (true) {
                let noMoreIterations = true;
                const expandedItems = [];
                for (const item of recycledItems) {
                    if (!this.hasRecycleDetails(item.itemId)) {
                        expandedItems.push(item);
                        continue;
                    }
                    if (this.recycleData[item.itemId][recyclerType]['yield'].length > 0 && !item.itemIsBlueprint &&
                        !IGNORED_RECYCLE_ITEMS.includes(item.itemId)) {
                        noMoreIterations = false;
                        for (const recycleItem of this.recycleData[item.itemId][recyclerType]['yield']) {
                            for (let i = 0; i < item.quantity; i++) {
                                if (recycleItem.probability < 1 && Math.random() > recycleItem.probability) continue;

                                const found = expandedItems.find(e => e.itemId === recycleItem.id);
                                if (found === undefined) {
                                    expandedItems.push({
                                        itemId: recycleItem.id,
                                        quantity: recycleItem.quantity,
                                        itemIsBlueprint: false
                                    });
                                }
                                else {
                                    found.quantity += recycleItem.quantity;
                                }
                            }
                        }
                    }
                    else {
                        const found = expandedItems.find(e => e.itemId === item.itemId &&
                            e.itemIsBlueprint === item.itemIsBlueprint);
                        if (found === undefined) {
                            expandedItems.push(item);
                        }
                        else {
                            found.quantity += item.quantity;
                        }
                    }
                }
                recycledItems = expandedItems.slice();
                if (noMoreIterations) break;
            }
            recycleData[recyclerType] = recycledItems;
        }

        return recycleData;
    }
}

module.exports = RustLabs;
