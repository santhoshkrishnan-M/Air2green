const fs=require('fs');const ts=require('topojson-simplify');const tc=require('topojson-client');
const topo=JSON.parse(fs.readFileSync(process.argv[2]));
let t=ts.presimplify(topo);
t=ts.simplify(t, ts.quantile(t, 0.35));
t=ts.filter(t, ts.filterWeight(t, 0, ts.planarRingArea)); // keep all rings (tiny islands)
const q=tc.quantize?tc.quantize(t,1e4):t;
fs.writeFileSync(process.argv[3], JSON.stringify(q));
const names=q.objects.countries.geometries.map(g=>[g.id,g.properties.name]);
fs.writeFileSync(process.argv[4], JSON.stringify(names));
console.log('features',names.length,'size',fs.statSync(process.argv[3]).size, 'noid', names.filter(n=>!n[0]).map(n=>n[1]).join('|'));
