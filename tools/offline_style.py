"""Стиль офлайн-карты (MapLibre) для векторных плиток Protomaps v4 — написан для «Карты сети»."""
import json, sys
OUT = sys.argv[1]
NAME = ["coalesce", ["get", "name:ru"], ["get", "name"]]
def zi(*pairs):
    return ["interpolate", ["exponential", 1.6], ["zoom"], *pairs]
PAL = {
  "light": dict(bg="#e9e5dc", earth="#efebe3", park="#cfe5c4", wood="#bcd9b0", farm="#f1eedd", urban="#e4e0d8", ind="#e6dfe8",
     water="#a7cfe8", water_l="#5d8fb3", building="#d9d2c6", building_l="#c7beb1", minor="#ffffff", minor_c="#d3cdc2", service="#f7f5f1",
     major="#fde8a9", major_c="#d2b46a", hw="#f9c473", hw_c="#c98a2b", path="#b9b1a5", rail="#9a948b", boundary="#a27fb4",
     label="#3b3a36", label_h="#ffffff", road_l="#55524c", place="#2b2a27", sub="#7b766d", addr="#8a857b"),
  "dark": dict(bg="#171a1f", earth="#1d2026", park="#1f2c24", wood="#203024", farm="#20231f", urban="#22252b", ind="#25222a",
     water="#122a3d", water_l="#7aa6c7", building="#2d3138", building_l="#3a3f47", minor="#3a3f48", minor_c="#2a2e35", service="#30353d",
     major="#5b5440", major_c="#3d3828", hw="#7a6235", hw_c="#4e3f22", path="#4b5059", rail="#5d6168", boundary="#8d72a0",
     label="#d6d9de", label_h="#14171b", road_l="#c2c6cc", place="#eceef1", sub="#9aa0a8", addr="#9aa0a8"),
}
def style(c):
    L = []
    add = L.append
    # фона нет: за границей района сквозь карту видна обычная подложка
    add({"id": "earth", "type": "fill", "source": "p", "source-layer": "earth", "paint": {"fill-color": c["earth"]}})
    add({"id": "landcover", "type": "fill", "source": "p", "source-layer": "landcover", "maxzoom": 9,
         "paint": {"fill-color": ["match", ["get", "kind"], "forest", c["wood"], "farmland", c["farm"], "urban_area", c["urban"], c["park"]],
                   "fill-opacity": ["interpolate", ["linear"], ["zoom"], 5, 0.8, 9, 0]}})
    add({"id": "landuse", "type": "fill", "source": "p", "source-layer": "landuse",
         "paint": {"fill-color": ["match", ["get", "kind"],
             ["park", "national_park", "nature_reserve", "protected_area", "cemetery", "golf_course", "grass", "grassland", "village_green", "allotments", "playground", "garden"], c["park"],
             ["forest", "wood", "scrub", "orchard", "vineyard"], c["wood"],
             ["farmland", "farm", "meadow"], c["farm"],
             ["industrial", "railway", "military", "airfield", "aerodrome", "naval_base", "quarry"], c["ind"],
             ["residential", "commercial", "retail", "hospital", "school", "university", "college"], c["urban"],
             "rgba(0,0,0,0)"],
             "fill-opacity": ["interpolate", ["linear"], ["zoom"], 6, 0, 10, 1]}})
    add({"id": "water", "type": "fill", "source": "p", "source-layer": "water", "filter": ["==", "$type", "Polygon"], "paint": {"fill-color": c["water"]}})
    add({"id": "water_lines", "type": "line", "source": "p", "source-layer": "water", "minzoom": 9, "filter": ["in", "kind", "river", "canal", "stream", "ditch", "drain"],
         "paint": {"line-color": c["water"], "line-width": zi(9, 0.5, 14, 1.5, 18, 8)}})
    add({"id": "buildings", "type": "fill", "source": "p", "source-layer": "buildings", "minzoom": 13, "filter": ["in", "kind", "building", "building_part"],
         "paint": {"fill-color": c["building"], "fill-outline-color": c["building_l"], "fill-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0, 14, 1]}})
    road = lambda kinds, extra=None: ["all", ["in", "kind", *kinds]] + ([extra] if extra else [])
    add({"id": "rail", "type": "line", "source": "p", "source-layer": "roads", "minzoom": 9, "filter": ["==", "kind", "rail"],
         "paint": {"line-color": c["rail"], "line-width": zi(9, 0.6, 18, 3), "line-dasharray": [3, 2]}})
    add({"id": "path", "type": "line", "source": "p", "source-layer": "roads", "minzoom": 14, "filter": road(["path", "other"]),
         "paint": {"line-color": c["path"], "line-width": zi(14, 0.6, 18, 2), "line-dasharray": [2, 1.5]}})
    add({"id": "minor_casing", "type": "line", "source": "p", "source-layer": "roads", "minzoom": 13, "filter": road(["minor_road"]),
         "layout": {"line-cap": "round", "line-join": "round"}, "paint": {"line-color": c["minor_c"], "line-width": zi(13, 1.2, 15, 4, 18, 15)}})
    add({"id": "minor", "type": "line", "source": "p", "source-layer": "roads", "minzoom": 11, "filter": road(["minor_road"]),
         "layout": {"line-cap": "round", "line-join": "round"},
         "paint": {"line-color": ["case", ["==", ["get", "kind_detail"], "service"], c["service"], c["minor"]], "line-width": zi(11, 0.4, 13, 0.9, 15, 2.6, 18, 12)}})
    add({"id": "major_casing", "type": "line", "source": "p", "source-layer": "roads", "minzoom": 8, "filter": road(["major_road"]),
         "layout": {"line-cap": "round", "line-join": "round"}, "paint": {"line-color": c["major_c"], "line-width": zi(8, 1, 12, 3, 15, 6, 18, 18)}})
    add({"id": "major", "type": "line", "source": "p", "source-layer": "roads", "minzoom": 6, "filter": road(["major_road"]),
         "layout": {"line-cap": "round", "line-join": "round"}, "paint": {"line-color": c["major"], "line-width": zi(6, 0.5, 12, 1.8, 15, 4, 18, 15)}})
    add({"id": "hw_casing", "type": "line", "source": "p", "source-layer": "roads", "minzoom": 5, "filter": road(["highway"]),
         "layout": {"line-cap": "round", "line-join": "round"}, "paint": {"line-color": c["hw_c"], "line-width": zi(5, 1, 12, 4, 15, 7.5, 18, 21)}})
    add({"id": "hw", "type": "line", "source": "p", "source-layer": "roads", "minzoom": 3, "filter": road(["highway"]),
         "layout": {"line-cap": "round", "line-join": "round"}, "paint": {"line-color": c["hw"], "line-width": zi(3, 0.5, 12, 2.5, 15, 5.5, 18, 18)}})
    sym = lambda size, color, halo, font="Noto Sans Regular": ({"text-font": [font], "text-size": size, "text-field": NAME},
                                                                {"text-color": color, "text-halo-color": halo, "text-halo-width": 1.4})
    lay, pt = sym(["interpolate", ["linear"], ["zoom"], 11, 10, 16, 13], c["label"], c["label_h"], "Noto Sans Italic")
    lay.update({"symbol-placement": "line", "text-max-angle": 30}); pt["text-color"] = c["water_l"]
    add({"id": "water_line_label", "type": "symbol", "source": "p", "source-layer": "water", "minzoom": 11, "filter": ["==", "$type", "LineString"], "layout": lay, "paint": pt})
    lay, pt = sym(["interpolate", ["linear"], ["zoom"], 8, 11, 14, 14], c["water_l"], c["label_h"], "Noto Sans Italic")
    add({"id": "water_label", "type": "symbol", "source": "p", "source-layer": "water", "filter": ["all", ["==", "$type", "Point"], ["has", "name"]],
         "layout": dict(lay, **{"text-max-width": 8}), "paint": pt})
    lay, pt = sym(["interpolate", ["linear"], ["zoom"], 13, 10.5, 17, 13.5], c["road_l"], c["label_h"])
    add({"id": "road_label", "type": "symbol", "source": "p", "source-layer": "roads", "minzoom": 13, "filter": ["in", "kind", "minor_road", "major_road", "highway"],
         "layout": dict(lay, **{"symbol-placement": "line", "text-max-angle": 35, "symbol-spacing": 300}), "paint": pt})
    add({"id": "address", "type": "symbol", "source": "p", "source-layer": "buildings", "minzoom": 17, "filter": ["has", "addr_housenumber"],
         "layout": {"text-field": ["get", "addr_housenumber"], "text-font": ["Noto Sans Regular"], "text-size": 11},
         "paint": {"text-color": c["addr"], "text-halo-color": c["label_h"], "text-halo-width": 1}})
    lay, pt = sym(["interpolate", ["linear"], ["zoom"], 11, 10, 16, 14], c["sub"], c["label_h"])
    add({"id": "subplace", "type": "symbol", "source": "p", "source-layer": "places", "minzoom": 11, "filter": ["in", "kind", "neighbourhood", "macrohood"],
         "layout": dict(lay, **{"text-transform": "uppercase", "text-letter-spacing": 0.08, "text-max-width": 7}), "paint": pt})
    size = ["interpolate", ["linear"], ["zoom"], 5, ["case", [">=", ["get", "population_rank"], 10], 13, 10],
            10, ["case", [">=", ["get", "population_rank"], 10], 18, [">=", ["get", "population_rank"], 7], 14, 12],
            15, ["case", [">=", ["get", "population_rank"], 10], 22, [">=", ["get", "population_rank"], 7], 17, 14]]
    lay, pt = sym(size, c["place"], c["label_h"], "Noto Sans Medium")
    add({"id": "locality", "type": "symbol", "source": "p", "source-layer": "places", "filter": ["==", "kind", "locality"],
         "layout": dict(lay, **{"symbol-sort-key": ["-", 20, ["coalesce", ["get", "population_rank"], 0]], "text-max-width": 8, "text-padding": 6}), "paint": pt})
    return {"version": 8, "name": "karta-offline", "glyphs": "GLYPHS/{fontstack}/{range}.pbf",
            "sources": {"p": {"type": "vector", "tiles": ["TILES/{z}/{x}/{y}.mvt"], "minzoom": 0, "maxzoom": 15, "attribution": "&copy; участники OpenStreetMap"}},
            "layers": L}
def desktop_style(base, dark=False):
    """Expose details present in the tiles; leave the Android style unchanged."""
    c=dict(base)
    c.update(dict(earth='#efeee8',urban='#e8e8e3',building='#d2b7a6',building_l='#a68d7c',
                  minor_c='#c4c2bb',path='#b18e70',addr='#655044',sub='#74746c') if not dark else
             dict(earth='#1d2026',urban='#262b30',building='#53535a',building_l='#82818a',
                  minor_c='#52565b',path='#a28b73',addr='#ddd3bd',sub='#a8a9ae'))
    s=style(c)
    layers=s['layers'];by={layer['id']:layer for layer in layers}
    by['buildings']['minzoom']=12
    by['buildings']['paint']['fill-opacity']=['interpolate',['linear'],['zoom'],12,.4,13,.95]
    by['landuse']['paint']['fill-color']=['match',['get','kind'],
        ['park','national_park','nature_reserve','protected_area','garden','recreation_ground','playground'],c['park'],
        ['forest','wood','scrub','orchard','vineyard'],c['wood'],
        ['farmland','farm','farmyard','meadow','grass','grassland','allotments'],c['farm'] if dark else '#dce5c8',
        ['school','kindergarten','college','university'],'#36372d' if dark else '#f3e8be',
        ['hospital','clinic'],'#422e38' if dark else '#f1d8dc',
        ['pitch','stadium','golf_course'],'#253b2e' if dark else '#c0ddb6',
        ['industrial','railway','military','aerodrome','airfield','quarry'],c['ind'],
        ['commercial','retail','supermarket','grocery'],'#382f2e' if dark else '#eddfd3',
        ['residential','neighbourhood'],c['urban'],
        ['pedestrian','footway','platform','pier'],'#383937' if dark else '#e4e1d7',
        ['cemetery','grave_yard'],'#2c3b30' if dark else '#d6dfc8',
        ['beach','sand'],'#443c29' if dark else '#f1e7c4',
        ['wetland'],'#253835' if dark else '#cbded3',
        'rgba(0,0,0,0)']
    by['water_lines']['filter']=['all',['==','$type','LineString'],['any',
        ['in','kind_detail','river','canal','stream','ditch','drain'],['in','kind','river','canal','stream','ditch','drain']]]
    by['water_lines']['minzoom']=10
    by['path']['minzoom']=12
    by['path']['paint']['line-width']=zi(12,.65,15,1.4,18,3)
    by['minor']['paint']['line-width']=zi(10,.5,12,1.1,14,2.5,16,5,18,12)
    by['minor_casing']['minzoom']=12
    by['minor_casing']['paint']['line-width']=zi(12,1.8,14,3.6,16,6.5,18,14)
    by['road_label']['minzoom']=12
    by['road_label']['filter']=['in','kind','minor_road','major_road','highway','path']
    by['road_label']['layout'].update({'text-size':['interpolate',['linear'],['zoom'],12,10.5,15,12,18,14],
                                      'symbol-spacing':220,'text-padding':3})
    by['address']['minzoom']=14
    by['address']['filter']=['all',['==','kind','address'],['has','addr_housenumber']]
    by['address']['layout'].update({'text-size':['interpolate',['linear'],['zoom'],14,10.5,16,12,18,14],
                                   'text-padding':1.5,'text-allow-overlap':False})
    by['address']['paint'].update({'text-color':c['addr'],'text-halo-width':1.3})
    # At close range show every supplied house number, even beside a street/POI label.
    by['address']['maxzoom']=17
    detailed_address=json.loads(json.dumps(by['address']))
    detailed_address.update(id='address-close',minzoom=17)
    detailed_address.pop('maxzoom',None)
    detailed_address['layout'].update({'text-allow-overlap':True,'text-ignore-placement':True})
    layers.append(detailed_address)
    by['subplace']['layout'].update({'text-size':['interpolate',['linear'],['zoom'],11,10,14,12,17,14],
                                    'text-transform':'none','text-letter-spacing':.02})
    primary=['hospital','clinic','doctors','pharmacy','school','kindergarten','college','university','post_office',
             'supermarket','fuel','station','bus_station','place_of_worship','townhall','marketplace','bank','fire_station']
    transit=['bus_stop','tram_stop','stop','parking']
    secondary=['convenience','grocery','cafe','restaurant','fast_food','hotel','motel','museum','library','cinema',
               'theatre','stadium','sports_centre','fitness_centre','playground','park','memorial','attraction',
               'bakery','butcher','car_repair','car_wash','hardware','electronics','clothes','department_store',
               'mall','furniture','florist','dentist','veterinary','hairdresser','beauty','books','community_centre']
    primary_filter=['in','kind',*primary]
    transit_filter=['in','kind',*transit]
    secondary_filter=['all',['in','kind',*secondary],['any',['has','name'],['has','name:ru']]]
    poi_color=['match',['get','kind'],['hospital','clinic','doctors','pharmacy'],'#dd94a7' if dark else '#a94460',
               ['school','kindergarten','college','university'],'#c3ab75' if dark else '#8b6e32',
               ['station','bus_station','bus_stop','tram_stop','stop','parking'],'#8cbbd4' if dark else '#396f95',
               '#c6ad87' if dark else '#886445']
    fallback=['match',['get','kind'],['hospital','clinic','doctors'],'Медицина','pharmacy','Аптека','school','Школа',
              'kindergarten','Детский сад',['college','university'],'Учебное заведение','post_office','Почта',
              ['supermarket','marketplace'],'Магазин','fuel','АЗС',['station','bus_station'],'Станция',
              'place_of_worship','Храм','townhall','Администрация','bank','Банк','fire_station','Пожарная часть',
              ['bus_stop','tram_stop','stop'],'Остановка','parking','P','']
    full_name=['case',['!=',['coalesce',NAME,''],''],NAME,fallback]
    short_name=['case',['>', ['length',full_name],38],['concat',['slice',full_name,0,37],'…'],full_name]
    extra=[]
    def poi_symbols(id,filter,minzoom):
        extra.append({'id':id+'-point','type':'circle','source':'p','source-layer':'pois','minzoom':minzoom,'filter':filter,
                      'paint':{'circle-radius':2.6,'circle-color':poi_color,'circle-stroke-color':c['label_h'],'circle-stroke-width':1.1}})
        extra.append({'id':id+'-label','type':'symbol','source':'p','source-layer':'pois','minzoom':minzoom,'filter':filter,
                      'layout':{'text-field':short_name,'text-font':['Noto Sans Regular'],
                                'text-size':['interpolate',['linear'],['zoom'],13,10.5,16,12,18,13],
                                'text-anchor':'left','text-offset':[.55,0],'text-max-width':12,'text-padding':4,
                                'symbol-sort-key':['coalesce',['get','min_zoom'],16]},
                      'paint':{'text-color':poi_color,'text-halo-color':c['label_h'],'text-halo-width':1.6}})
    poi_symbols('poi-primary',primary_filter,13)
    poi_symbols('poi-transit',transit_filter,14.5)
    poi_symbols('poi-secondary',secondary_filter,15)
    extra.insert(0,{'id':'trees','type':'circle','source':'p','source-layer':'pois','minzoom':15,'filter':['==','kind','tree'],
                    'paint':{'circle-radius':['interpolate',['linear'],['zoom'],15,1.6,18,3.5],
                             'circle-color':'#59795b' if dark else '#91b477','circle-opacity':.65}})
    at=next(i for i,layer in enumerate(layers) if layer['id']=='address')
    layers[at:at]=extra
    # Later symbol layers win placement: streets and major landmarks precede house numbers.
    symbol_order=['water_line_label','water_label','poi-secondary-label','poi-transit-label','address',
                  'poi-primary-label','road_label','subplace','locality','address-close']
    symbols={layer['id']:layer for layer in layers if layer['type']=='symbol'}
    s['layers']=[layer for layer in layers if layer['type']!='symbol']+[symbols[id] for id in symbol_order]
    return yandex_like(s,dark)

# Светлая схема ПК в духе «Яндекс Карт»: светлый тёплый фон, белые улицы, жёлтые и оранжевые
# магистрали, светло-серые дома, зелёные парки, голубая вода. Только локальные шрифты Noto Sans.
YA={'light':dict(bg='#f3f1ec',earth='#f3f1ec',urban='#e9e6df',park='#d3ebc5',wood='#c4e2b0',farm='#f0efe4',
                 ind='#e9e6e3',water='#a9d3f5',water_l='#3d79b5',building='#dfdad2',building_l='#c9c2b7',
                 minor='#ffffff',minor_c='#dcd7ce',service='#ffffff',major='#fff6d1',major_c='#e3cf8f',
                 primary='#ffe28a',primary_c='#e6b85a',hw='#ffc55c',hw_c='#e09a2c',path='#c9b9a6',rail='#a9a6a1',
                 boundary='#b98bc0',label='#333333',label_h='#ffffff',road_l='#4a4a4a',place='#1f1f1f',
                 village='#3a3a3a',sub='#7a7a7a',addr='#6e675e',school='#f6ecd2',hospital='#f8e1e1',
                 sport='#cfe8c0',cemetery='#dbe6d0',sand='#f6ecc8',wetland='#d3e6dc',pedestrian='#efede8',
                 retail='#f3e6e1'),
    'dark':dict(bg='#1d2026',earth='#1d2026',urban='#24282e',park='#1f2c24',wood='#203024',farm='#20231f',
                ind='#25222a',water='#16324a',water_l='#7aa6c7',building='#3a3e46',building_l='#4a4f58',
                minor='#3a3f48',minor_c='#2a2e35',service='#33383f',major='#4b4f58',major_c='#2f3238',
                primary='#6b5f3e',primary_c='#3d3828',hw='#8a6a35',hw_c='#4e3f22',path='#5a5650',rail='#5d6168',
                boundary='#8d72a0',label='#d6d9de',label_h='#14171b',road_l='#c2c6cc',place='#eceef1',
                village='#d8dbe0',sub='#9aa0a8',addr='#c9c2b2',school='#36372d',hospital='#422e38',
                sport='#253b2e',cemetery='#2c3b30',sand='#443c29',wetland='#253835',pedestrian='#2a2d33',
                retail='#382f2e')}
def yandex_like(s,dark):
    y=YA['dark' if dark else 'light']
    layers=s['layers'];by={l['id']:l for l in layers}
    def width(*p): return zi(*p)
    by['earth']['paint']['fill-color']=y['earth']
    layers.insert(0,{'id':'background','type':'background','paint':{'background-color':y['bg']}})
    by['landcover']['paint']['fill-color']=['match',['get','kind'],'forest',y['wood'],'farmland',y['farm'],
        'urban_area',y['urban'],['grassland','scrub'],y['park'],'barren',y['sand'],y['park']]
    by['landuse']['paint']['fill-color']=['match',['get','kind'],
        ['park','national_park','nature_reserve','protected_area','garden','recreation_ground','playground','village_green','grass','grassland'],y['park'],
        ['forest','wood','scrub','orchard','vineyard'],y['wood'],
        ['farmland','farm','farmyard','meadow','allotments'],y['farm'],
        ['school','kindergarten','college','university'],y['school'],
        ['hospital','clinic'],y['hospital'],
        ['pitch','stadium','golf_course','sports_centre'],y['sport'],
        ['industrial','railway','military','aerodrome','airfield','quarry','naval_base','landfill'],y['ind'],
        ['commercial','retail','supermarket','grocery'],y['retail'],
        ['residential','neighbourhood'],y['urban'],
        ['pedestrian','footway','platform','pier'],y['pedestrian'],
        ['cemetery','grave_yard'],y['cemetery'],
        ['beach','sand'],y['sand'],
        ['wetland'],y['wetland'],
        'rgba(0,0,0,0)']
    by['landuse']['paint']['fill-opacity']=['interpolate',['linear'],['zoom'],7,0,9,1]
    by['water']['paint']['fill-color']=y['water']
    by['water_lines']['paint']['line-color']=y['water']
    by['water_lines']['minzoom']=9
    by['water_lines']['paint']['line-width']=width(9,['match',['get','kind'],['river','canal'],0.8,0.3],14,['match',['get','kind'],['river','canal'],3,1.2],18,['match',['get','kind'],['river','canal'],14,4])
    b=by['buildings']
    b['minzoom']=11
    b['paint']={'fill-color':y['building'],'fill-outline-color':y['building_l'],
                'fill-opacity':['interpolate',['linear'],['zoom'],11,.5,13,1]}
    # дома крупно: тонкий контур по краю, как у Яндекса
    outline={'id':'buildings-outline','type':'line','source':'p','source-layer':'buildings','minzoom':15,
             'filter':['in','kind','building','building_part'],
             'paint':{'line-color':y['building_l'],'line-width':['interpolate',['linear'],['zoom'],15,.4,18,1.2]}}
    layers.insert(layers.index(b)+1,outline)
    # дороги
    by['path']['paint']['line-color']=y['path']
    by['rail']['paint']['line-color']=y['rail']
    by['minor_casing']['paint']['line-color']=y['minor_c']
    by['minor']['paint']['line-color']=['case',['==',['get','kind_detail'],'service'],y['service'],y['minor']]
    prim=['in',['get','kind_detail'],['literal',['primary','primary_link','trunk','trunk_link']]]
    by['major_casing']['paint']['line-color']=['case',prim,y['primary_c'],y['major_c']]
    by['major']['paint']['line-color']=['case',prim,y['primary'],y['major']]
    by['major_casing']['paint']['line-width']=width(8,['case',prim,1.4,0.9],12,['case',prim,4,3],15,['case',prim,8,6.5],18,['case',prim,24,19])
    by['major']['paint']['line-width']=width(6,['case',prim,0.8,0.4],12,['case',prim,2.6,1.8],15,['case',prim,6.2,4.8],18,['case',prim,21,16])
    by['hw_casing']['paint']['line-color']=y['hw_c']
    by['hw']['paint']['line-color']=y['hw']
    # границы областей и районов — пунктир
    bnd={'id':'boundaries','type':'line','source':'p','source-layer':'boundaries','minzoom':5,
         'filter':['<=',['get','kind_detail'],6],
         'paint':{'line-color':y['boundary'],'line-opacity':.7,'line-dasharray':[3,2],
                  'line-width':['interpolate',['linear'],['zoom'],5,['case',['<=',['get','kind_detail'],4],1,.5],12,['case',['<=',['get','kind_detail'],4],2.2,1]]}}
    first_road=next(i for i,l in enumerate(layers) if l['id']=='rail')
    layers.insert(first_road,bnd)
    # подписи
    for l in layers:
        if l['type']=='symbol' and 'text-halo-color' in l.get('paint',{}):
            l['paint']['text-halo-color']=y['label_h']
    by['road_label']['paint'].update({'text-color':y['road_l'],'text-halo-width':1.6})
    by['water_label']['paint']['text-color']=y['water_l']
    by['water_line_label']['paint']['text-color']=y['water_l']
    for a in ('address','address-close'):
        by[a]['paint']['text-color']=y['addr']
        by[a]['minzoom']=15 if a=='address' else 16.5
    by['address']['maxzoom']=16.5
    by['subplace']['paint']['text-color']=y['sub']
    loc=by['locality']
    kd=['get','kind_detail']
    big=['match',kd,'city',1,0]
    loc['filter']=['==',['get','kind'],'locality']
    loc['layout'].update({
        'text-font':['case',['in',kd,['literal',['city','town']]],['literal',['Noto Sans Medium']],['literal',['Noto Sans Regular']]],
        'text-size':['interpolate',['linear'],['zoom'],
            6,['match',kd,'city',14,'town',11,9],
            9,['match',kd,'city',18,'town',14,'village',11.5,10],
            12,['match',kd,'city',22,'town',17,'village',14,'hamlet',12,11],
            15,['match',kd,'city',24,'town',20,'village',17,'hamlet',14,12.5]],
        'symbol-sort-key':['match',kd,'city',0,'town',1,'village',2,'hamlet',3,4],
        'text-padding':3,'text-max-width':9})
    loc['paint'].update({'text-color':['match',kd,['city','town'],y['place'],y['village']],'text-halo-width':1.8,
                         'text-halo-color':y['label_h']})
    del big
    detail_layers(s,y,dark)
    return s

# Детализация для прокладки линий (слои karta и contours, сборка 3.4.7): ЛЭП и опоры, подстанции,
# вышки связи, водонапорные башни, полевые дороги, лесополосы, канавы, дамбы, трубопроводы,
# курганы, отметки высот, горизонтали через 10 м; угодья — своими оттенками.
def detail_layers(s,y,dark):
    L=s['layers'];by={l['id']:l for l in L}
    def at(id): return next(i for i,l in enumerate(L) if l['id']==id)
    def ins(before,*new):
        i=at(before)
        L[i:i]=list(new)
    D=dark
    col=lambda light,darkc: darkc if D else light
    # угодья
    lu=by['landuse']['paint']['fill-color']
    lu[2:2]=[['orchard'],col('#d9ecc2','#24331f'),['vineyard'],col('#e5ebc6','#2b3122'),
             ['farmyard'],col('#efe5d8','#2d2a26'),['greenhouse_horticulture'],col('#e1eef1','#22303a'),
             ['quarry'],col('#e4ddd2','#302c27'),['landfill'],col('#e2dacb','#312d25'),
             ['construction','brownfield'],col('#ebe6dd','#2b2a28'),['plant_nursery'],col('#d6ebc8','#22311f'),
             ['basin','salt_pond'],y['water']]
    seen=set();out=lu[:2]
    for i in range(2,len(lu)-1,2):
        labels=[v for v in (lu[i] if isinstance(lu[i],list) else [lu[i]]) if v not in seen]
        seen.update(labels)
        if labels: out+= [labels,lu[i+1]]
    out.append(lu[-1]);lu[:]=out
    # посевные поля — едва заметная заливка с контуром межи
    ins('water',{'id':'farmland-outline','type':'line','source':'p','source-layer':'landuse','minzoom':12,
        'filter':['in','kind','farmland','orchard','vineyard'],
        'paint':{'line-color':col('#e2dfcc','#2c2f28'),'line-width':['interpolate',['linear'],['zoom'],12,.4,16,1]}})
    ins('water',{'id':'power-area','type':'fill','source':'p','source-layer':'karta','minzoom':11,
        'filter':['all',['==','$type','Polygon'],['in','kind','substation','power_plant']],
        'paint':{'fill-color':col('#ece2ea','#30283a'),'fill-outline-color':col('#b48cae','#7d6290')}})
    # горизонтали
    ins('water',{'id':'contours','type':'line','source':'p','source-layer':'contours','minzoom':11,
        'filter':['has','ele'],
        'paint':{'line-color':col('#c8a27c','#6b5a45'),
                 'line-opacity':['interpolate',['linear'],['zoom'],11,['match',['get','idx'],1,.45,0],12,['match',['get','idx'],1,.6,.35],15,['match',['get','idx'],1,.75,.5]],
                 'line-width':['interpolate',['linear'],['zoom'],11,['match',['get','idx'],1,.6,.3],16,['match',['get','idx'],1,1.3,.7]]}})
    # канавы, трубы под дорогами, дамбы, обрывы
    ins('buildings',{'id':'culvert','type':'line','source':'p','source-layer':'karta','minzoom':14,'filter':['==','kind','culvert'],
        'paint':{'line-color':y['water_l'],'line-width':1.4,'line-dasharray':[1,1]}},
        {'id':'dam','type':'line','source':'p','source-layer':'karta','minzoom':12,'filter':['in','kind','dam','weir','embankment'],
        'paint':{'line-color':col('#a39e95','#77736b'),'line-width':['interpolate',['linear'],['zoom'],12,1,16,3.5]}},
        {'id':'cliff','type':'line','source':'p','source-layer':'karta','minzoom':13,'filter':['==','kind','cliff'],
        'paint':{'line-color':col('#b0927a','#7c6a5a'),'line-width':1.2,'line-dasharray':[1,1]}},
        {'id':'tree_row','type':'line','source':'p','source-layer':'karta','minzoom':12,'filter':['in','kind','tree_row','hedge'],
        'layout':{'line-cap':'round'},
        'paint':{'line-color':col('#9ccb86','#3b5a34'),'line-width':['interpolate',['linear'],['zoom'],12,1.2,15,3,18,8]}})
    # полевые дороги: коричневый пунктир, как у Яндекса
    ins('path',{'id':'track','type':'line','source':'p','source-layer':'roads','minzoom':11,'filter':['all',['==','kind','path'],['==','kind_detail','track']],
        'layout':{'line-cap':'butt'},
        'paint':{'line-color':col('#bfa07a','#7b6a55'),'line-width':['interpolate',['linear'],['zoom'],11,.5,14,1.3,18,3.2],
                 'line-dasharray':[3,1.5]}})
    by['path']['filter']=['all',['in','kind','path','other'],['!=','kind_detail','track']]
    # мосты: тёмная обводка
    ins('minor_casing',{'id':'bridge-casing','type':'line','source':'p','source-layer':'roads','minzoom':13,
        'filter':['all',['has','is_bridge'],['in','kind','minor_road','major_road','highway']],
        'paint':{'line-color':col('#9a958d','#6b6f76'),'line-width':['interpolate',['exponential',1.6],['zoom'],13,4,15,9,18,26]}})
    # трубопроводы и ЛЭП поверх дорог
    first_sym=next(i for i,l in enumerate(L) if l['type'] in ('symbol','circle'))
    L[first_sym:first_sym]=[
        {'id':'pipeline','type':'line','source':'p','source-layer':'karta','minzoom':11,'filter':['==','kind','pipeline'],
         'paint':{'line-color':col('#8f8a84','#9a958e'),'line-width':['interpolate',['linear'],['zoom'],11,.7,16,2],
                  'line-dasharray':[4,2]}},
        {'id':'power-minor','type':'line','source':'p','source-layer':'karta','minzoom':12,'filter':['in','kind','power_minor','power_cable'],
         'paint':{'line-color':col('#9b86b3','#9a86b0'),'line-width':['interpolate',['linear'],['zoom'],12,.5,17,1.2],'line-opacity':.85}},
        {'id':'power-line','type':'line','source':'p','source-layer':'karta','minzoom':9,'filter':['==','kind','power_line'],
         'paint':{'line-color':col('#7d62a0','#a58cc4'),'line-width':['interpolate',['linear'],['zoom'],9,.5,13,1,17,2],'line-opacity':.9}},
        {'id':'power-tower','type':'circle','source':'p','source-layer':'karta','minzoom':13,'filter':['in','kind','power_tower','power_pole'],
         'paint':{'circle-radius':['interpolate',['linear'],['zoom'],13,['match',['get','kind'],'power_tower',1.6,1],17,['match',['get','kind'],'power_tower',3.6,2.4]],
                  'circle-color':col('#6f5394','#b39ad0'),'circle-stroke-color':y['label_h'],'circle-stroke-width':.8}},
        {'id':'landmark-point','type':'circle','source':'p','source-layer':'karta','minzoom':11,
         'filter':['in','kind','mast','tower','water_tower','substation','power_plant','chimney','silo','storage_tank','windmill',
                   'water_well','pumping_station','water_works','wastewater_plant','lighthouse','peak','survey_point','kurgan','dam'],
         'paint':{'circle-radius':['interpolate',['linear'],['zoom'],11,2.4,16,4.2],
                  'circle-color':['match',['get','kind'],['mast','tower'],'#d2462e',['water_tower','water_well','pumping_station','water_works','wastewater_plant'],'#3d79b5',
                                  ['substation','power_plant'],'#7d62a0',['peak','survey_point'],col('#5b4a3a','#c9b8a5'),['kurgan'],'#9a6b3c','#7a7a7a'],
                  'circle-stroke-color':y['label_h'],'circle-stroke-width':1.2}}]
    # подписи
    kd=['get','kind']
    lm_name=['case',['!=',['coalesce',['get','name:ru'],['get','name'],''],''],['coalesce',['get','name:ru'],['get','name']],
             ['match',kd,'mast','Вышка связи','tower',['case',['==',['get','tower_type'],'communication'],'Вышка связи','Вышка'],
              'water_tower','Водонапорная башня','substation','Подстанция','power_plant','Электростанция','chimney','Труба',
              'silo','Силос','storage_tank','Резервуар','windmill','Мельница','water_well','Скважина','pumping_station','Насосная станция',
              'water_works','Водозабор','wastewater_plant','Очистные','lighthouse','Маяк','kurgan','Курган','dam','Плотина',
              'peak','','survey_point','Геодезический пункт','']]
    ele=['case',['has','ele'],['concat',['to-string',['round',['to-number',['get','ele'],0]]],' м'],'']
    text=['case',['in',kd,['literal',['peak','survey_point']]],
          ['case',['!=',lm_name,''],['concat',lm_name,'\n',ele],ele],lm_name]
    L.insert(next(i for i,l in enumerate(L) if l['id']=='road_label')+1,
        {'id':'landmark-label','type':'symbol','source':'p','source-layer':'karta','minzoom':12,
         'filter':['in','kind','mast','tower','water_tower','substation','power_plant','chimney','silo','storage_tank','windmill',
                   'water_well','pumping_station','water_works','wastewater_plant','lighthouse','peak','survey_point','kurgan','dam'],
         'layout':{'text-field':text,'text-font':['Noto Sans Regular'],'text-size':['interpolate',['linear'],['zoom'],12,10,16,12],
                   'text-anchor':'left','text-offset':[.6,0],'text-max-width':9,'text-padding':2},
         'paint':{'text-color':['match',kd,['mast','tower'],'#b23a25',['water_tower','water_well','pumping_station','water_works','wastewater_plant'],y['water_l'],
                                ['substation','power_plant'],col('#6a4f8c','#b9a2d4'),col('#5b4a3a','#c9b8a5')],
                  'text-halo-color':y['label_h'],'text-halo-width':1.5}})
    voltage=['/',['to-number',['get','voltage'],0],1000]
    L.insert(at('landmark-label'),
        {'id':'power-label','type':'symbol','source':'p','source-layer':'karta','minzoom':13,'filter':['==','kind','power_line'],
         'layout':{'symbol-placement':'line','symbol-spacing':400,'text-font':['Noto Sans Regular'],'text-size':10,
                   'text-field':['case',['>',voltage,0],['concat','ЛЭП ',['to-string',voltage],' кВ'],'ЛЭП']},
         'paint':{'text-color':col('#6a4f8c','#b9a2d4'),'text-halo-color':y['label_h'],'text-halo-width':1.4}})
    L.insert(at('power-label'),
        {'id':'contour-label','type':'symbol','source':'p','source-layer':'contours','minzoom':13,
         'filter':['any',['==',['get','idx'],1],['>=',['zoom'],14.5]],
         'layout':{'symbol-placement':'line','symbol-spacing':350,'text-font':['Noto Sans Italic'],'text-size':9.5,
                   'text-field':['to-string',['get','ele']],'text-max-angle':25},
         'paint':{'text-color':col('#a9825a','#9c8669'),'text-halo-color':y['label_h'],'text-halo-width':1.2}})
    L.insert(at('road_label'),
        {'id':'track-label','type':'symbol','source':'p','source-layer':'roads','minzoom':14,'filter':['all',['==','kind','path'],['==','kind_detail','track']],
         'layout':{'symbol-placement':'line','text-font':['Noto Sans Regular'],'text-size':10,'text-field':NAME},
         'paint':{'text-color':col('#7d6448','#b9a68e'),'text-halo-color':y['label_h'],'text-halo-width':1.4}})

out = {k: style(c) for k, c in PAL.items()}
with open(OUT + "/offline-style.js", "w", encoding="utf-8") as f:
    f.write("/* Стиль офлайн-карты «Карты сети» для MapLibre GL (плитки Protomaps v4, данные OpenStreetMap).\n"
            " * Файл создан скриптом; TILES и GLYPHS подставляет maps.js. */\n")
    f.write("window.KartaStyle=" + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n")
with open(OUT + '/offline-style-pc.js','w',encoding='utf-8') as f:
    f.write('/* Подробная офлайн-схема ПК: локальные данные, без внешних значков и шрифтов. */\n')
    pc={k:desktop_style(c,k=='dark') for k,c in PAL.items()}
    f.write('window.KartaStylePC='+json.dumps(pc,ensure_ascii=False,separators=(',',':'))+';\n')
print("ok")
