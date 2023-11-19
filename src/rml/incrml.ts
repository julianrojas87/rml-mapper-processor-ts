import type { Stream, Writer } from "@ajuvercr/js-runner";
import { createHash } from "crypto";
import {
    Quad,
    Store,
    Parser,
    Writer as N3Writer,
    DataFactory,
    NamedNode,
    BlankNode,
} from "n3";
import { IDLAB_FN, LDES, RDF, RML, RR, FNO, FNML, RMLT, TREE, VOID, XSD } from "../voc";
import { Quad_Object } from "@rdfjs/types";

const { quad, namedNode, blankNode, literal } = DataFactory;

export const BASE = "http://mapping.example.com/#";

export type IncRMLConfig = {
    stateBasePath: string,
    lifeCycleConfig: LifeCycleConfig
    targetConfig?: LDESTargetConfig
};

type LifeCycleConfig = {
    predicate: string,
    create: { function: string, type: string },
    update: { function: string, type: string },
    delete: { function: string, type: string }
};

type LDESTargetConfig = {
    targetPath: string,
    timestampPath: string,
    versionOfPath: string,
    serialization: string,
    uniqueIRIs: boolean,
    ldesBaseIRI?: string,
    shape?: string
}

type MappingGroup = {
    subjectTemplate: string,
    triplesMaps: Quad[]
};

type TriplesMapsPerGraphMap = {
    _subject: Quad_Object | undefined,
    triplesMaps: string[]
};
type GraphMapsPerSource = {
    [logicalSource: string]: {
        _subject: Quad_Object,
        [graphMap: string]: Quad_Object | TriplesMapsPerGraphMap
    }
};

type EntityEvent = "create" | "update" | "delete";

type TriplesMapsConfig = {
    eventType: EntityEvent,
    template: string,
    logSrc: string,
    graphMap: string,
    logSrcQuad: Quad_Object,
    graphMapQuad: Quad_Object | undefined,
    triplesMaps: string[],
    stateBasePath: string,
    counter: number
};

export async function rml2incrml(
    rmlStream: Stream<string>,
    config: IncRMLConfig,
    starmlStream: Writer<string>,
    bulkMode?: boolean
) {
    let store = new Store();
    let index = 0;

    rmlStream.data(async rml => {
        const rdfParser = new Parser();
        if (!bulkMode) {
            store = new Store();
            // Proceed to expand the mappings and stream them out
            store.addQuads(rdfParser.parse(rml));
            expand2StateAware(store, config).forEach(async mapping => {
                await starmlStream.push(new N3Writer().quadsToString(mapping.triplesMaps));
            });
        } else {
            // Make sure IRIs are unique across mapping sources
            const SENSITIVE_PREDICATES = [RDF.type, RML.referenceFormulation, RR.predicate, RR.constant, RR.termType];
            store.addQuads(rdfParser.parse(rml).map(q => {
                // Append index number to all NNodes/BNodes to avoid conflicts across mapping files
                const uniqueQuad = quad(
                    q.subject instanceof NamedNode ? namedNode(`${q.subject.value}_${index}`)
                        : q.subject instanceof BlankNode ? blankNode(`${q.subject.value}_${index}`) : q.subject,
                    q.predicate,
                    // Except for the sensitive predicate cases
                    SENSITIVE_PREDICATES.includes(q.predicate.value) ? q.object
                        : q.object instanceof NamedNode ? namedNode(`${q.object.value}_${index}`)
                            : q.object instanceof BlankNode ? blankNode(`${q.object.value}_${index}`) : q.object,
                    q.graph
                );

                return uniqueQuad;
            }));
            index++;
        }
    }).on("end", async () => {
        if (bulkMode) {
            expand2StateAware(store, config).forEach(async mapping => {
                await starmlStream.push(new N3Writer().quadsToString(mapping.triplesMaps));
            });
        }
    });
}

function expand2StateAware(rmlStore: Store, config: IncRMLConfig): MappingGroup[] {
    /**
     * Extract all rr:TriplesMaps per rr:template and rml:LogicalSource.
     * It gives the following data structure:
     * 
     *  Map { 
     *      rr:template | rr:constant | rml:reference | fnml:functionValue => { 
     *          rml:logicalSource: {
     *              "_subject": Quad_Object,
     *              rr:graphMap/rr:constant: {
     *                  "_subject": Quad_Object,
     *                  "triplesMaps": [ rr:TriplesMap ]
     *              } 
     *          } 
     *      } 
     *  }
     * 
     * */
    const triplesMapsPerTemplate = extractTriplesMapsPerTemplate(rmlStore);
    // Incremental sequence used to guarantee unique IRIs
    let counter = 0;

    // Iterate over sets of rr:TripleMaps and expand them into a state-aware version (Create, Update and Delete).
    // We create a single TriplesMap per event, that merges all TMs associated 
    // with the same IRI template, Logical Source and Named Graph (if any)
    for (const template of triplesMapsPerTemplate.keys()) {
        const templateObj: GraphMapsPerSource = triplesMapsPerTemplate.get(template)!;

        for (const logSrc of Object.keys(templateObj)) {
            const logSrcObj = templateObj[logSrc]!;

            for (const graphMap of Object.keys(logSrcObj)) {
                if (graphMap !== "_subject") {
                    const graphMapObj = <TriplesMapsPerGraphMap>logSrcObj[graphMap]!;

                    ["create", "update", "delete"].forEach(event => {
                        rmlStore.addQuads(generateTriplesMapQuads(
                            {
                                eventType: <EntityEvent>event,
                                template,
                                logSrc,
                                graphMap,
                                logSrcQuad: logSrcObj._subject,
                                graphMapQuad: graphMapObj._subject,
                                triplesMaps: graphMapObj.triplesMaps,
                                stateBasePath: config.stateBasePath,
                                counter
                            },
                            rmlStore,
                            config.lifeCycleConfig,
                            config.targetConfig
                        ));
                    });

                    // Delete unnecessary triples
                    graphMapObj.triplesMaps.forEach(tm => {
                        // Delete all quads of orphan Subject Map
                        const smQ = rmlStore.getQuads(tm, RR.subjectMap, null, null)[0];
                        if (smQ) {
                            rmlStore.removeQuads(rmlStore.getQuads(smQ.object, null, null, null));
                        }
                        // Delete all triples of the original Triples Map
                        rmlStore.removeQuads(rmlStore.getQuads(tm, null, null, null));
                        rmlStore.removeQuads(rmlStore.getQuads(null, null, tm, null));
                    });


                    counter++;
                }
            }
        }
    }

    return [{
        subjectTemplate: "",
        triplesMaps: rmlStore.getQuads(null, null, null, null)
    }];
}

function extractTriplesMapsPerTemplate(store: Store): Map<string, GraphMapsPerSource> {
    const map: Map<string, GraphMapsPerSource> = new Map();
    const subjectMaps: Quad[] = [];

    /**
     * We start by gathering all the Subject Maps.
     * From here there is the option of having either rr:template, rml:reference, rr:const or a FnO function.
     * In the case of a FnO function, we take the function's entity identifier as reference.
     */

    // Get all Subject Map quads
    subjectMaps.push(...store.getQuads(null, RR.subjectMap, null, null));

    if (subjectMaps.length > 0) {
        for (const subMapQ of subjectMaps) {
            let template: string | null = null;

            // Find the quad that produces the actual subject IRI
            if (store.getObjects(subMapQ.object, RR.constant, null)[0]) {
                // It is given as a rr:constant
                template = store.getObjects(subMapQ.object, RR.constant, null)[0].value;
            } else if (store.getObjects(subMapQ.object, RR.template, null)[0]) {
                // It is given through a rr:template
                template = store.getObjects(subMapQ.object, RR.template, null)[0].value;
            } else if (store.getObjects(subMapQ.object, RML.reference, null)[0]) {
                // It is given through a rml:reference
                template = store.getObjects(subMapQ.object, RML.reference, null)[0].value;
            } else if (store.getObjects(subMapQ.object, FNML.functionValue, null)[0]) {
                // It is the result of a conditional FnO function
                // Here we keep the identifier of the FnO function since the actual template
                // may be implicit an result from the execution of the function
                template = store.getObjects(subMapQ.object, FNML.functionValue, null)[0].value;
            } else {
                throw new Error(`Malformed Subject Map ${subMapQ.object.value} does not have a known way to produce an IRI`);
            }

            if (!template) {
                throw new Error(`Unexpected error while processing the Subject Map ${subMapQ.object}`);
            } else {
                // Check if the associated Triples Map has at least one Predicate-Object Map
                if (store.getQuads(subMapQ.subject, RR.predicateObjectMap, null, null).length > 0) {
                    // Get a reference quad of the related Logical Source (and GraphMap if any) 
                    const logSrcObj = store.getObjects(subMapQ.subject, RML.logicalSource, null)[0];
                    const logSrcVal = store.getObjects(logSrcObj, RML.source, null)[0].value;

                    const graphMapObj = store.getObjects(subMapQ.object, RR.graphMap, null)[0];
                    const graphMap = graphMapObj
                        ? store.getObjects(graphMapObj, RR.constant, null)[0].value
                        : "default";

                    writeToMap(
                        map,
                        template,
                        logSrcObj,
                        logSrcVal,
                        subMapQ.subject.value,
                        graphMap,
                        graphMapObj ? graphMapObj : undefined
                    );
                }
            }
        }
    }

    return map;
}

function writeToMap(
    map: Map<string, GraphMapsPerSource>,
    template: string,
    logSrcObj: Quad_Object,
    logSrcVal: string,
    triplesMap: string,
    graphMap: string,
    graphMapQuad?: Quad_Object
): void {
    if (map.has(template)) {
        const obj = map.get(template)!;
        if (obj[logSrcVal]) {
            if (obj[logSrcVal][graphMap]) {
                // New triples map
                (<TriplesMapsPerGraphMap>obj[logSrcVal][graphMap]).triplesMaps.push(triplesMap);
            } else {
                // New graph map for this logical source
                obj[logSrcVal][graphMap] = {
                    _subject: graphMapQuad,
                    triplesMaps: [triplesMap]
                };
            }
        } else {
            // New logical source for this template
            obj[logSrcVal] = {
                _subject: logSrcObj,
                [graphMap]: {
                    _subject: graphMapQuad,
                    triplesMaps: [triplesMap]
                }
            };
        }
    } else {
        // Completely new IRI template
        map.set(template, {
            [logSrcVal]: {
                _subject: logSrcObj,
                [graphMap]: {
                    _subject: graphMapQuad,
                    triplesMaps: [triplesMap]
                }
            }
        });
    }
}

function generateTriplesMapQuads(
    params: TriplesMapsConfig,
    store: Store,
    lifeCycleModel: LifeCycleConfig,
    ldesTargetConfig?: LDESTargetConfig
): Quad[] {
    const {
        eventType,
        template,
        logSrc,
        graphMap,
        logSrcQuad,
        graphMapQuad,
        triplesMaps,
        stateBasePath,
        counter
    } = params;

    const newTMQuads: Quad[] = [];

    const LDES_LT = namedNode(`${BASE}LDES_LT`);
    const TM = namedNode(`${BASE}${eventType}_TM_${counter}`);
    const FTM = namedNode(`${BASE}${eventType}_FTM_${counter}`);
    const FV = namedNode(`${BASE}${eventType}_FV_${counter}`);
    const EXEC_POM = namedNode(`${BASE}${eventType}_executes_POM_${counter}`);
    const EXEC_OM = namedNode(`${BASE}${eventType}_executes_OM_${counter}`);
    const IRI_POM = namedNode(`${BASE}${eventType}_iri_POM_${counter}`);
    const IRI_OM = namedNode(`${BASE}${eventType}_iri_OM_${counter}`);
    const STATE_POM = namedNode(`${BASE}${eventType}_state_POM_${counter}`);
    const STATE_OM = namedNode(`${BASE}${eventType}_state_OM_${counter}`);
    const LC_POM = namedNode(`${BASE}${eventType}_lifecycle_POM_${counter}`);
    const LC_OM = namedNode(`${BASE}${eventType}_lifecycle_OM_${counter}`);

    // Define the LDES Logical Target (if target config is given)
    if (ldesTargetConfig) {
        const VOID_TARGET = namedNode(`${BASE}void_target`);
        const LDES_TARGET = namedNode(`${BASE}ldes_target`);

        newTMQuads.push(...[
            quad(LDES_LT, RDF.terms.type, RMLT.terms.EventStreamTarget),
            quad(LDES_LT, RMLT.terms.target, VOID_TARGET),
            quad(VOID_TARGET, RDF.terms.type, VOID.terms.Dataset),
            quad(VOID_TARGET, VOID.terms.dataDump, literal(ldesTargetConfig.targetPath)),
            quad(LDES_LT, RMLT.terms.serialization, namedNode(ldesTargetConfig.serialization)),
            quad(
                LDES_LT,
                RMLT.terms.ldesGenerateImmutableIRI,
                literal(ldesTargetConfig.uniqueIRIs.toString(), namedNode(XSD.custom("boolean")))
            ),
            quad(LDES_LT, RMLT.terms.ldes, LDES_TARGET),
            quad(FTM, RML.terms.logicalTarget, LDES_LT)
        ]);
        // Optional rmlt:ldesBaseIRI
        if (ldesTargetConfig.ldesBaseIRI) {
            newTMQuads.push(quad(LDES_LT, RMLT.terms.ldesBaseIRI, namedNode(ldesTargetConfig.ldesBaseIRI)));
        }
        // Optional ldes:timestampPath
        if (ldesTargetConfig.timestampPath) {
            newTMQuads.push(quad(LDES_TARGET, LDES.terms.timestampPath, namedNode(ldesTargetConfig.timestampPath)));
        }
        // Optional ldes:versionOfPath
        if (ldesTargetConfig.versionOfPath) {
            newTMQuads.push(quad(LDES_TARGET, LDES.terms.versionOfPath, namedNode(ldesTargetConfig.versionOfPath)));
        }
        // Optional tree:shape
        if (ldesTargetConfig.shape) {
            newTMQuads.push(quad(LDES_TARGET, TREE.terms.shape, namedNode(ldesTargetConfig.shape)));
        }
    }

    // New rr:TriplesMap definition
    newTMQuads.push(...[
        quad(TM, RDF.terms.type, RR.terms.TriplesMap),
        quad(TM, RML.terms.logicalSource, logSrcQuad),
        quad(TM, RR.terms.subjectMap, FTM),
        quad(FTM, RDF.terms.type, RR.terms.FunctionTermMap)
    ]);

    // Optional rr:graphMap
    if (graphMapQuad) {
        newTMQuads.push(...[
            quad(FTM, RR.terms.graphMap, graphMapQuad)
        ]);
    }

    // Optional rr:class
    const rrClass: Quad[] = [];
    triplesMaps.forEach(tm => {
        const sm = store.getQuads(tm, RR.subjectMap, null, null)[0];
        rrClass.push(...store.getQuads(sm.object, RR.class, null, null));
    });
    if (rrClass.length > 0) {
        // Validate that there are no conflicting class types
        if (rrClass.every(t => t.object.value === rrClass[0].object.value)) {
            newTMQuads.push(quad(FTM, RR.terms.class, rrClass[0].object));
        } else {
            throw new Error(`Different values of rr:class encountered for Triples Maps of the same entity in ${rrClass.map(c => c.subject.value).join(",")}`);
        }
    }

    // Function Term Map definition of the stateful function
    newTMQuads.push(...[
        quad(FTM, FNML.terms.functionValue, FV),
        quad(FV, RR.terms.predicateObjectMap, EXEC_POM),
        quad(EXEC_POM, RR.terms.predicate, FNO.terms.executes),
        quad(EXEC_POM, RR.terms.objectMap, EXEC_OM),
        quad(EXEC_OM, RR.terms.constant, namedNode(lifeCycleModel[eventType].function)),
        quad(FV, RR.terms.predicateObjectMap, IRI_POM),
        quad(IRI_POM, RR.terms.predicate, IDLAB_FN.terms.iri),
        quad(IRI_POM, RR.terms.objectMap, IRI_OM)
    ]);

    /**
     * We assume that all Subject Maps for the same Logical Source and IRI template will be equivalent.
     * It wouldn't make much sense to define conditional and unconditional Subject Maps for the same source and entity
     * next to each other. If this is still done, it could be a sign of poorly designed mappings 
     * where conditional Predicate-Object maps could be used instead.
     * 
     * In this implementation we will check that they are all the same and throw an error otherwise. 
    */

    const sMaps: Quad[] = [];
    const fVals: Quad[] = [];
    triplesMaps.forEach(tm => {
        const sMap = store.getQuads(tm, RR.subjectMap, null, null)[0];
        sMaps.push(sMap);
        const fVal = store.getQuads(sMap.object, FNML.functionValue, null, null)[0];
        if (fVal) {
            fVals.push(fVal);
        }
    });

    if (fVals.length > 0) {
        if (fVals.length === triplesMaps.length) {
            // This is a conditional Subject Map → Embed the condition function within the idlab-fn:iri parameter
            newTMQuads.push(quad(IRI_OM, FNML.terms.functionValue, fVals[0].object));
        } else {
            throw new Error(`Found inconsistent Subject Maps for the same entity and logical source: ${sMaps.map(s => s.object.value).join(", ")}`);
        }
    } else {
        // Set the Subject Map IRI template as a value of the idlab-fn:iri parameter
        newTMQuads.push(quad(IRI_OM, RR.terms.template, literal(template)));
    }

    // Define the idlab-fn:watchedProperty parameter if this is an implicit Update
    if (eventType === "update" && lifeCycleModel.update.function === IDLAB_FN.implicitUpdate) {
        const WATCHED_POM = namedNode(`${BASE}${eventType}_watched_POM_${counter}`);
        const WATCHED_OM = namedNode(`${BASE}${eventType}_watched_OM_${counter}`);
        const wpTemplate: string[] = [];
        const propExpressions = new Set();

        // Extract all used properties
        triplesMaps.forEach(tm => {
            // Iterate over every associated Predicate-Object Map
            const pomQs = store.getQuads(tm, RR.predicateObjectMap, null, null);
            for (const pomQ of pomQs) {
                const omQ = store.getQuads(pomQ.object, RR.objectMap, null, null)[0];
                // Check if Object Map is resolved via a FnO function
                const fvQ = store.getQuads(omQ.object, FNML.functionValue, null, null)[0];

                if (fvQ) {
                    // Iterate over function's POMs and look recursively for the rml:reference or rr:template
                    const props = findPropertyRecursively(fvQ.object, store);
                    if (props) {
                        props.forEach(p => propExpressions.add(p));
                    } else {
                        throw new Error(`We couldn't find an rml:reference for this function-based POM: ${pomQ.object.value}`);
                    }
                } else if (store.getQuads(omQ.object, RR.template, null, null).length > 0) {
                    // Look for rr:template 
                    const tptQ = store.getQuads(omQ.object, RR.template, null, null)[0];
                    if (tptQ) {
                        const tpt = tptQ.object.value;
                        // Extract values from within {}
                        const tptMatches = tpt.match(/[^{}]+(?=})/g);
                        if (tptMatches) {
                            tptMatches.forEach(p => propExpressions.add(p));
                        }
                    }
                } else {
                    // Look for rml:reference
                    const refQ = store.getQuads(omQ.object, RML.reference, null, null)[0];
                    if (refQ) {
                        propExpressions.add(refQ.object.value);
                    }
                }
            }
        });

        let c = 0;
        propExpressions.forEach(prop => {
            wpTemplate.push(`prop${c}=${prop}`);
            c++;
        });
        newTMQuads.push(...[
            quad(FV, RR.terms.predicateObjectMap, WATCHED_POM),
            quad(WATCHED_POM, RR.terms.predicate, IDLAB_FN.terms.watchedProperty),
            quad(WATCHED_POM, RR.terms.objectMap, WATCHED_OM),
            quad(WATCHED_OM, RML.terms.reference, literal(wpTemplate.join("&")))
        ]);
    }

    // Define a state file per IRI template + logical source name + graph map, 
    // so that state is kept across Triple Maps of the same entity
    const hash = createHash("md5");
    newTMQuads.push(...[
        quad(FV, RR.terms.predicateObjectMap, STATE_POM),
        quad(STATE_POM, RR.terms.predicate, IDLAB_FN.terms.state),
        quad(STATE_POM, RR.terms.objectMap, STATE_OM),
        quad(
            STATE_OM,
            RR.terms.constant,
            literal(`${stateBasePath}/${hash.update(template + logSrc + graphMap).digest("hex")}_${eventType}_state`)
        ),
        quad(STATE_OM, RR.terms.dataType, XSD.terms.string)
    ]);
    // Lifecycle POM triples
    newTMQuads.push(...[
        quad(TM, RR.terms.predicateObjectMap, LC_POM),
        quad(LC_POM, RDF.terms.type, RR.terms.predicateObjectMap),
        quad(LC_POM, RR.terms.predicate, namedNode(lifeCycleModel.predicate)),
        quad(LC_POM, RR.terms.objectMap, LC_OM),
        quad(LC_OM, RR.terms.constant, namedNode(lifeCycleModel[eventType].type)),
        quad(LC_OM, RR.terms.termType, RR.terms.IRI),
    ]);
    // Predicate-object maps with regular properties (if not a delete)
    if (eventType !== "delete") {
        triplesMaps.forEach(tm => {
            store.getQuads(tm, RR.predicateObjectMap, null, null).forEach(pom => {
                newTMQuads.push(quad(TM, RR.terms.predicateObjectMap, pom.object));
            });
        });
    }

    return newTMQuads;
}

// Recursive function used to find the rml:reference or rr:template value used within a fnml:functionValue
function findPropertyRecursively(fv: Quad_Object, store: Store): Array<string> | null {
    for (const fpomQ of store.getQuads(fv, RR.predicateObjectMap, null, null)) {
        const fomQ = store.getQuads(fpomQ.object, RR.objectMap, null, null)[0];
        const ffv = store.getQuads(fomQ.object, FNML.functionValue, null, null)[0];

        if (ffv) {
            return findPropertyRecursively(ffv.object, store);
        } else {
            // Check if rml:reference is defined
            const rmlRef = store.getQuads(fomQ.object, RML.reference, null, null)[0];
            if (rmlRef) {
                return [rmlRef.object.value];
            }

            // Now check for rr:template and process it if so
            const rrTemplate = store.getQuads(fomQ.object, RR.template, null, null)[0];
            if (rrTemplate) {
                const tpt = rrTemplate.object.value;
                return tpt.match(/[^{}]+(?=})/g);
            }
        }
    }

    return null;
}