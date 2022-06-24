require("dotenv").config()
const axios = require('axios');

const crypto = require('crypto')
const rateLimit = require('axios-rate-limit');

const http = rateLimit(axios.create(), { maxRequests: 2, perMilliseconds: 1000, maxRPS: 2 }) // throttle webhook requests. Works fine.
 

const makeHash = (data) => {
    const dt = new Date();
    data["date"] = (dt.getDay()+1).toString() + "." + (dt.getMonth()+1).toString();
    return crypto.createHash('md5').update(JSON.stringify(data)).digest('hex') // bonk, very ugly I know.
}


const send_webhook_embed = async(data) => {
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
    if(data.messages && data.messages.join("\n").length < 1000) {
        embed.fields.push({
            name: "Meldungen", // senk you for traeveling
            value: data.messages.join("\n"),
            inline: false
        })
    } else if(data.messages) {
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

    let msgid;
    try {
        const msg = await http.post(data.start_bf.includes(process.env.HOME_VARIANT) ? process.env.HOME_WH+"?wait=true" : process.env.WORK_WH+"?wait=true", { // dont code like me kids mkay
            embeds: [embed],
            username: "Bahnhof " + data.start_bf,
            avatar_url: data.start_bf.includes(process.env.HOME_VARIANT) ? process.env.HOME_IMAGE : process.env.WORK_IMAGE
        })

        msgid = msg.data.id;
    } catch (e) {
        console.error(e)
    }
    return [((data.start_bf.includes(process.env.HOME_VARIANT) ? process.env.HOME_WH : process.env.WORK_WH)+"/messages/"+msgid) ?? "1234567899",embed] // lol this really needs refactor

}
const fetch_station = async(station_id, train_names) => {
    const fetch_url = `https://marudor.de/api/iris/v2/abfahrten/${station_id}?lookahead=90&lookbehind=10`; // hardcoding aka shitcoding
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
const poller = async() => {
    let traindata = {}
    while(true) {
        try {
            let [stat1, stat2] = await Promise.all([fetch_station(process.env.HOME_ID, process.env.TRAINS.split(",")),fetch_station(process.env.WORK_ID, process.env.TRAINS.split(","))]); // very ugly code
            let [stat1_hash, stat2_hash] = [stat1.map(tt => makeHash(tt)), stat2.map(tt => makeHash(tt))]; // tracking changes by hashing objects is very unprofessional.
            let current_hashes = Object.values(traindata).map(tt => tt.relevant.hash);
            for(let i = stat1_hash.length-1; i >= 0; i--) {
                if(!current_hashes.includes(stat1_hash[i])) {
    
                    const [wh_out, sentEmb] = await send_webhook_embed(stat1[i]);
                    if(traindata[stat1[i].trainid]) {
                        try {
                            await http.delete(traindata[stat1[i].trainid].del_url);
                            
                        } catch(err){}
                        delete train[stat1[i].trainid]
                        
                    }
                    traindata[stat1[i].trainid] = {
                        relevant: {
                            id: stat1[i].trainid,
                            hash: stat1_hash[i],
                            actual: stat1[i].actual_unix,
                            home: true
                        },
                        del_url: wh_out,
                        posted: Date.now(),
                        emb_data: sentEmb,

                    }
                }
            }
            for(let i = stat2_hash.length -1; i >= 0; i--) { 
                if(!current_hashes.includes(stat2_hash[i])) {
    
                    const [wh_out, sentEmb] = await send_webhook_embed(stat2[i]);
                    if(traindata[stat2[i].trainid]) {
                        try {
                            await http.delete(traindata[stat2[i].trainid].del_url);
                            
                        } catch(err){}
                        delete traindata[stat2[i].trainid]
                    }
                    traindata[stat2[i].trainid] = {
                        relevant: {
                            id: stat2[i].trainid,
                            hash: stat2_hash[i],
                            actual: stat2[i].actual_unix,
                            home: false
                        },
                        del_url: wh_out,
                        posted: Date.now(),
                        emb_data: sentEmb,

                    }
                }
            }
            const curt = Date.now() / 1000;
            Object.values(traindata).filter(tt => (tt.relevant.actual + 60 * 15) < curt).forEach(tt => { // bug: if a train has 20 mins delay, it's gone.
                try {
                    delete traindata[tt.id]
                    http.delete(tt.del_url);
                } catch(err){}
            })

            const bubbleSort = (inputArr) => {
                let len = inputArr.length;
                let checked;
                let ops = []
                do {
                    checked = false;
                    for (let i = 0; i < len -1; i++) {
                        if (inputArr[i].relevant.actual > inputArr[i + 1].relevant.actual) {
                            let tmp = inputArr[i];
                            ops.push([inputArr[i].relevant.id, inputArr[i+1].relevant.id])
                            inputArr[i] = inputArr[i + 1];
                            inputArr[i + 1] = tmp;
                            checked = true;
                        }
                    }
                } while (checked);
                return ops;
            };
            const sortHome = bubbleSort(Object.values(traindata).filter(o => o.relevant.home === true).sort((a,b) => b.posted - a.posted))
            console.log(sortHome)
            for(let i = 0; i < sortHome.length; i++) {
                const itm = sortHome[i]
                const old_set = traindata[itm[0]]

                await http.patch(traindata[itm[0]].del_url, {embeds: [traindata[itm[1]].emb_data]})
                await http.patch(traindata[itm[1]].del_url, {embeds: [traindata[itm[0]].emb_data]})
                traindata[itm[0]].del_url = traindata[itm[1]].del_url
                traindata[itm[0]].posted = traindata[itm[1]].posted
                traindata[itm[1]].posted = old_set.posted
                traindata[itm[1]].del_url = old_set.del_url

                
            }
            const sortWork = bubbleSort(Object.values(traindata).filter(o => o.relevant.home === false).sort((a,b) => b.posted - a.posted))
            console.log(sortWork)
            for(let i = 0; i < sortWork.length; i++) {
                const itm = sortWork[i]
                const old_set = traindata[itm[0]]

                await http.patch(traindata[itm[0]].del_url, {embeds: [traindata[itm[1]].emb_data]})
                await http.patch(traindata[itm[1]].del_url, {embeds: [traindata[itm[0]].emb_data]})
                traindata[itm[0]].del_url = traindata[itm[1]].del_url
                traindata[itm[0]].posted = traindata[itm[1]].posted
                traindata[itm[1]].posted = old_set.posted
                traindata[itm[1]].del_url = old_set.del_url

                
            }     

        } catch(err) {
            console.error(err)
        }



        await new Promise(resolve => setTimeout(resolve, 20000));
    }
}
poller()
