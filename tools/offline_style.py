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
out = {k: style(c) for k, c in PAL.items()}
with open(OUT + "/offline-style.js", "w", encoding="utf-8") as f:
    f.write("/* Стиль офлайн-карты «Карты сети» для MapLibre GL (плитки Protomaps v4, данные OpenStreetMap).\n"
            " * Файл создан скриптом; TILES и GLYPHS подставляет maps.js. */\n")
    f.write("window.KartaStyle=" + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n")
print("ok")
