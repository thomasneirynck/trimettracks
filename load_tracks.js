const {Client} = require('@elastic/elasticsearch');
const readline = require('readline');
const yargs = require('yargs');
const rp = require('request-promise-native');


const DEFAULT_INDEX_NAME = 'trimettracks';
const DEFAULT_UPDATE_DELTA = 5000; //ms
const MAX_UPDATE_DELTA = 5000; //ms
const DEFAULT_HOST = `http://localhost:9200`;
const DEFAULT_API_KEY = 'YOUR_API_KEY';
const TRIMET_API_URL = `https://developer.trimet.org/ws/v2/vehicles`;

const argv = yargs
    .option('index', {
        alias: 'i',
        description: 'name of the elasticsearch index',
        type: 'string',
        default: DEFAULT_INDEX_NAME,
    })
    .option('frequency', {
        alias: 'f',
        description: `Update delta of the tracks in ms. Cannot be smaller than ${MAX_UPDATE_DELTA}`,
        type: 'number',
        default: DEFAULT_UPDATE_DELTA,
    })
    .option('host', {
        alias: 'h',
        description: 'URL of the elasticsearch server',
        type: 'string',
        default: DEFAULT_HOST,
    })
    .option('apikey', {
        alias: 'a',
        description: 'API Key',
        type: 'string',
        default: DEFAULT_API_KEY,
    })
    .help()
    .argv;

const tracksIndexName = argv.index;
const updateDelta = Math.max(argv.frequency, MAX_UPDATE_DELTA); //milliseconds
const apiKey = argv.apikey;

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const esClient = new Client({
    node: argv.host,
    auth: {
        username: 'elastic',
        password: 'changeme'
    },
    ssl: {
        rejectUnauthorized: false
    }
});

async function init() {
    await setupIndex();
    loadTracks();
}

init();

async function recreateIndex() {
    console.log(`Create index ${tracksIndexName}`);
    try {
        await esClient.indices.create({
            index: tracksIndexName,
            body: {
                mappings: {
                    "properties": {
                        'location': {
                            "type": 'geo_point',
                            "ignore_malformed": true
                        },
                        "vehicle_ref": {
                            "type": "keyword"
                        },
                        "bearing": {
                            "type": "double"
                        },
                        "@timestamp": {
                            "type": "date"
                        },
                        "index_time": {
                            "type": "date"
                        },
                        "in_congestion": {
                            type: "boolean"
                        },
                        "route_number": {
                            type: "double"
                        },
                        "type": {
                            type: "keyword"
                        }
                    }
                }
            }
        });
    } catch (e) {
        console.error(e.body.error);
        throw e;
    }
}

async function setupIndex() {

    return new Promise(async (resolve, reject) => {

        try {
            await esClient.ping({});
        } catch (e) {
            console.error('Cannot reach Elasticsearch', e);
            reject(e);
        }

        try {

            const {body} = await esClient.indices.exists({
                index: tracksIndexName,
            });

            if (body) {
                rl.question(`Index "${tracksIndexName}" exists. Should delete and recreate? [n|Y]`, async function (response) {
                    if (response === 'y' || response === 'Y') {
                        console.log(`Deleting index "${tracksIndexName}"`);
                        await esClient.indices.delete({
                            index: tracksIndexName
                        });
                        await recreateIndex();
                    } else {
                        console.log('Retaining existing index');
                    }
                    resolve();
                });

            } else {
                await recreateIndex();
                resolve();
            }

        } catch (e) {
            console.error(e.message);
            reject(e);
        }
    });
}

let tickCounter = 0;

async function loadTracks() {
    console.log(`[${tickCounter}-------------- LOAD TRACKS`);
    try {
        const busses = await getBusses();


        const bulkInsert = [];
        for (let i = 0; i < busses.length; i++) {
            bulkInsert.push({
                index: {
                    _index: tracksIndexName,
                }
            });
            bulkInsert.push(busses[i]);
        }

        await esClient.bulk({
            body: bulkInsert
        });
    } catch (e) {
        console.log('Cannot load tracks');
        console.error(e);
    }
    tickCounter++;
    setTimeout(loadTracks, updateDelta);
}

async function getBusses() {

    const uri = `${TRIMET_API_URL}?appID=${apiKey}`;
    const options = {
        uri: uri,
        headers: {
            'User-Agent': 'Request-Promise'
        },
        json: true
    };
    const response = await rp(options);

    const vehicles = response.resultSet.vehicle;
    console.log(`nr of busses ${vehicles.length}`);

    return vehicles.map((vehicle) => {
        return {
            location: {
                lon: vehicle.longitude,
                lat: vehicle.latitude
            },
            bearing: vehicle.bearing, // hack to use 2D semantics (probable bug in maps https://github.com/elastic/kibana/issues/77496)
            vehicle_ref: vehicle.vehicleID,
            ["@timestamp"]: (new Date(vehicle.time)).toISOString(),
            index_time: (new Date()).toISOString(),
            route_number: vehicle.routeNumber,
            in_congestion: !!vehicle.inCongestion,
            type: vehicle.type,
        };
    });

}