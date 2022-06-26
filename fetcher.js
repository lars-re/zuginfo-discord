require("dotenv").config()
const axios = require('axios');

const rateLimit = require('axios-rate-limit');

const http = rateLimit(axios.create(), { maxRequests: 2, perMilliseconds: 1000, maxRPS: 2 }) // throttle webhook requests. Works fine.
 

const prep_embed = (data) => {
    let embed = {
        title: "",
        description: data.cancelled ? "⚠⚠⚠ **ZUG FÄLLT AUS** ⚠⚠⚠" : "", // why am I even commenting this in english
        color: data.name.includes(process.env.EMBED_VARIANT) ? 0x54cc5e : 0x18edf5,
        author: {
            name: `${data.name} nach ${data.destination}`,
        },
        fields: [{
                name: "Abfahrt",
                value: data.plan_departure === data.actual_departure ? data.plan_departure : `⌚⚠ **Verspätet**: ${data.actual_departure} (**+${data.delay_mins.toString()}**)\n\n*Ursprünglich: ${data.plan_departure}*`,
                inline: true
            },
            {
                name: "Gleis",
                value: data.platform,
                inline: true
            }
        ]

    }
    if(data.messages && data.messages.join("\n").length > 5 && data.messages.join("\n").length < 1000) {
        embed.fields.push({
            name: "Meldungen", // senk you for traeveling
            value: data.messages.join("\n"),
            inline: false
        })
    } else if(data.messages && data.messages.join("\n").length > 5) {
       let out = []
       let curr = ""
       data.messages.forEach(el => {
        if(curr.length+el.length > 1000) {
            out.push(curr);
            curr = el + "\n"
        } else {
            curr += el + "\n"
        }
       })
       if(curr.length>1) {
        out.push(curr.substring(0,curr.length-1))
       }
       for(let i = 0; i < out.length; i++) {
        embed.fields.push({
            name: i === 0 ? "Meldungen" : "_ _",
            value: out[i],
            inline: false
        })
       }
    }
    return {
            embeds: [embed],
            username: "Bahnhof " + data.start_bf,
            avatar_url: data.start_bf.includes(process.env.HOME_VARIANT) ? process.env.HOME_IMAGE : process.env.WORK_IMAGE
    }

}
const fetch_station = async(station_id, train_names) => {
    const fetch_url = `https://marudor.de/api/iris/v2/abfahrten/${station_id}?lookahead=480&lookbehind=10`; // hardcoding aka shitcoding
    const reqD = await axios.get(fetch_url);
    let jsonDat = reqD.data.departures.filter(tt => train_names.includes(tt.train.name));

    const pase = jsonDat.reduce(function(lst, train){

    if(!train.departure) {return lst;}
        if(train.currentStopPlace.name.includes(process.env.HOME_VARIANT) && process.env.EXCLUDE_HOMEVIEW.split(",").some(oo => train.destination.includes(oo))) {
            return lst;
        }
        if(train.currentStopPlace.name.includes(process.env.WORK_VARIANT) && process.env.EXCLUDE_WORKVIEW.split(",").some(oo => train.destination.includes(oo))) { // This is a POC dont judge me pls
            return lst;
        }
        let actual_departure = new Date(train.departure.time)
        const actual_unix = parseInt(actual_departure.getTime() / 1000);
        let plan_departure = new Date(train.departure.scheduledTime)
        actual_departure = actual_departure.getHours().toString().padStart(2, '0') + ":" + actual_departure.getMinutes().toString().padStart(2, '0') // shame on me
        plan_departure = plan_departure.getHours().toString().padStart(2, '0') + ":" + plan_departure.getMinutes().toString().padStart(2, '0')
        
        let [delM, accM, zugI] = [train.messages.delay, train.messages.qos, train.messages.him];
        const parseMsg = (m) => {return m.map((m) => {
            return "▫️ "+ m.text.trim()
        })};
        let messages = [...parseMsg(delM), ...parseMsg(accM), ...parseMsg(zugI)]

        
        lst.push({
            name: train.train.name,
            destination: train.destination,
            delay_mins: train.departure.delay ?? 0,
            platform: train.departure.platform,
            cancelled: train.departure.cancelled ?? false,
            plan_departure,
            actual_departure,
            messages,
            actual_unix, // not really "actual" but whatever
            trainid: train.train.number,
            start_bf: train.currentStopPlace.name
        });
        return lst;

    }, [])

    return pase

    
}
const fillEmpty = async() => {
    let slots_a = []
    let slots_b = []
    for(let i = 0; i < 5; i++) {
        const resp = await http.post( process.env.HOME_WH+"?wait=true", {embeds: [{title: "Information", description: "Keine weiteren Fahrten verfügbar."}]})
        slots_a.push( {url: process.env.HOME_WH +  "/messages/" +resp.data.id})
    }
    for(let i = 0; i < 5; i++) {
        const resp = await http.post( process.env.WORK_WH+"?wait=true", {embeds: [{title: "Information", description: "Keine weiteren Fahrten verfügbar."}]})
        slots_b.push( {url: process.env.WORK_WH + "/messages/" +resp.data.id})
    }
    return [slots_a, slots_b]
}
const poller = async() => {

    let [slots_a, slots_b] = await fillEmpty();
    while(true) {
        try {
            let [stat1, stat2] = await Promise.all([fetch_station(process.env.HOME_ID, process.env.TRAINS.split(",")),fetch_station(process.env.WORK_ID, process.env.TRAINS.split(","))]); // very ugly code
            let send_a = []
            let send_b = []
            for(let i = stat1.length-1; i >= 0; i--) {
                    send_a.push({
                        relevant: {
                            id: stat1[i].trainid,
                            actual: stat1[i].actual_unix,
                            home: true
                        },
                        emb_data: prep_embed(stat1[i])
                    })
            }
            for(let i = stat2.length-1; i >= 0; i--) {

                    send_b.push({
                        relevant: {
                            id: stat2[i].trainid,
                            actual: stat2[i].actual_unix,
                            home: false
                        },
                        emb_data: prep_embed(stat2[i])
                    })
            }
 
            send_a = send_a.sort((a,b) => a.relevant.actual - b.relevant.actual).slice(0,5).reverse()
            send_b = send_b.sort((a,b) => a.relevant.actual - b.relevant.actual).slice(0,5).reverse()
            for(let i = 0; i < 5; i++) {
                 if(slots_a[i].data !== send_a[i].emb_data) {
                    await http.patch(slots_a[i].url, send_a[i].emb_data)
                    slots_a[i].data = send_a[i].emb_data
                }
            }
            for(let i = 0; i < 5; i++) {
                if(slots_b[i].data !== send_b[i].emb_data) {
                    await http.patch(slots_b[i].url, send_b[i].emb_data)
                    slots_b[i].data = send_b[i].emb_data
                }
            }
        } catch(err) {
            console.error(err)
        }

        await new Promise(resolve => setTimeout(resolve, 20000));
    }
}
poller()
