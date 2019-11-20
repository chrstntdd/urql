import { pipe, tap, map } from 'wonka';
import { Exchange, Operation } from '../types';
import {
  DocumentNode,
  buildClientSchema,
  visitWithTypeInfo,
  TypeInfo,
  FragmentDefinitionNode,
  SelectionSetNode,
  GraphQLSchema,
  IntrospectionQuery,
  FragmentSpreadNode,
  GraphQLObjectType,
  GraphQLInterfaceType,
  ASTNode,
} from 'graphql';
import { visit } from 'graphql';

interface ExchangeArgs {
  schema: IntrospectionQuery;
}

/** An exchange for auto-populating mutations with a required response body. */
export const populateExchange = ({
  schema: ogSchema,
}: ExchangeArgs): Exchange => ({ forward }) => {
  const schema = buildClientSchema(ogSchema);
  /** List of operation keys that have already been parsed. */
  const parsedOperations = new Set<number>();
  /** List of operation keys that have not been torn down. */
  const activeOperations = new Set<number>();
  /** Collection of fragments used by the user. */
  let userFragments: UserFragmentMap = {};
  /** Collection of type fragments. */
  let typeFragments: TypeFragmentMap = {};

  /** Handle mutation and inject selections + fragments. */
  const handleIncomingMutation = (op: Operation) => {
    if (op.operationName !== 'mutation') {
      return op;
    }

    const activeSelections = Object.entries(typeFragments).reduce(
      (state, [key, value]) => ({
        ...state,
        [key]: value.filter(s => activeOperations.has(s.key)),
      }),
      typeFragments
    );

    return {
      ...op,
      query: addFragmentsToQuery({
        schema,
        typeFragments: activeSelections,
        userFragments: userFragments,
        query: op.query,
      }),
    };
  };

  /** Handle query and extract fragments. */
  const handleIncomingQuery = ({ key, operationName, query }: Operation) => {
    activeOperations.add(key);

    if (operationName !== 'query' || parsedOperations.has(key)) {
      return;
    }

    parsedOperations.add(key);

    const {
      fragments: newFragments,
      selections: newSelections,
    } = extractSelectionsFromQuery({
      schema,
      query,
    });

    userFragments = newFragments.reduce(
      (state, fragment) => ({
        ...state,
        [fragment.name.value]: fragment,
      }),
      userFragments
    );

    typeFragments = newSelections.reduce((state, { selections, type }) => {
      const current = state[type] || [];
      const entry: TypeFragment = {
        key,
        fragment: {
          kind: 'FragmentDefinition',
          typeCondition: {
            kind: 'NamedType',
            name: {
              kind: 'Name',
              value: type,
            },
          },
          name: {
            kind: 'Name',
            value: `${type}_PopulateFragment_${current.length}`,
          },
          selectionSet: selections,
        },
        type,
      };
      return {
        ...state,
        [type]: [...current, entry],
      };
    }, typeFragments);
  };

  const handleIncomingTeardown = ({ key, operationName }: Operation) => {
    if (operationName !== 'teardown') {
      return;
    }

    activeOperations.delete(key);
  };

  return ops$ => {
    return pipe(
      ops$,
      tap(handleIncomingQuery),
      tap(handleIncomingTeardown),
      map(handleIncomingMutation),
      forward
    );
  };
};

type UserFragmentMap<T extends string = string> = Record<
  T,
  FragmentDefinitionNode
>;

type TypeFragmentMap<T extends string = string> = Record<T, TypeFragment[]>;

interface TypeFragment {
  /** Operation key where selection set is being used. */
  key: number;
  /** Selection set. */
  fragment: FragmentDefinitionNode;
  /** Type of selection. */
  type: string;
}

interface MakeFragmentsFromQueryArg {
  schema: GraphQLSchema;
  query: DocumentNode;
}

/** Gets typed selection sets and fragments from query */
export const extractSelectionsFromQuery = ({
  schema,
  query,
}: MakeFragmentsFromQueryArg) => {
  let selections: { selections: SelectionSetNode; type: string }[] = [];
  let fragments: FragmentDefinitionNode[] = [];
  const typeInfo = new TypeInfo(schema);

  visit(
    query,
    visitWithTypeInfo(typeInfo, {
      Field: node => {
        if (!node.selectionSet) {
          return undefined;
        }

        const type = getType(typeInfo);

        if (!type) {
          return undefined;
        }

        selections = [...selections, { selections: node.selectionSet, type }];
      },
      FragmentDefinition: node => {
        fragments = [...fragments, node];
      },
    })
  );

  return { selections, fragments };
};

interface AddFragmentsToQuery {
  schema: GraphQLSchema;
  query: DocumentNode;
  typeFragments: Record<string, Omit<TypeFragment, 'key'>[]>;
  userFragments: UserFragmentMap;
}

/** Replaces populate decorator with fragment spreads + fragments. */
export const addFragmentsToQuery = ({
  schema,
  query,
  typeFragments,
  userFragments,
}: AddFragmentsToQuery) => {
  const typeInfo = new TypeInfo(schema);
  const requiredUserFragments = new Set<FragmentDefinitionNode>();
  let additionalFragments: Record<string, FragmentDefinitionNode> = {};

  return visit(
    query,
    visitWithTypeInfo(typeInfo, {
      Field: {
        enter: node => {
          if (
            !node.directives ||
            !node.directives.find(d => d.name.value === 'populate')
          ) {
            return;
          }

          const directives = node.directives.filter(
            d => d.name.value !== 'populate'
          );

          const types = getTypes(schema, typeInfo);
          const newSelections = types.reduce((p, t) => {
            const typeFrags = typeFragments[t.name];
            if (!typeFrags) {
              return p;
            }

            return [
              ...p,
              ...typeFragments[t.name].map(({ fragment }) => {
                // Add used fragment for insertion at Document node
                getUsedFragments(fragment).forEach(f =>
                  requiredUserFragments.add(userFragments[f])
                );

                // Add fragment for insertion at Document node
                additionalFragments = {
                  ...additionalFragments,
                  [fragment.name.value]: fragment,
                };

                return {
                  kind: 'FragmentSpread',
                  name: {
                    kind: 'Name',
                    value: fragment.name.value,
                  },
                } as const;
              }),
            ];
          }, [] as FragmentSpreadNode[]);

          const existingSelections =
            (node.selectionSet && node.selectionSet.selections) || [];
          const selections =
            existingSelections.length + newSelections.length !== 0
              ? [...newSelections, ...existingSelections]
              : [
                  {
                    kind: 'Field',
                    name: {
                      kind: 'Name',
                      value: '__typename',
                    },
                  },
                ];

          return {
            ...node,
            directives,
            selectionSet: {
              kind: 'SelectionSet',
              selections,
            },
          };
        },
      },
      Document: {
        leave: node => {
          return {
            ...node,
            definitions: [
              ...node.definitions,
              ...Object.values(additionalFragments),
              ...[...requiredUserFragments],
            ],
          };
        },
      },
    })
  );
};

/** Get all possible types for node with TypeInfo. */
const getTypes = (schema: GraphQLSchema, typeInfo: TypeInfo) => {
  const type = typeInfo.getType();

  if (!type || !('ofType' in type)) {
    console.warn('PopulateExchange: Unsupported type at populate decorator.');
    return [];
  }

  const ofType = type.ofType;

  if (ofType instanceof GraphQLInterfaceType) {
    return schema.getPossibleTypes(ofType);
  }

  return [ofType as GraphQLObjectType];
};

/** Get fragment names referenced by node. */
const getUsedFragments = (node: ASTNode) => {
  let names: string[] = [];

  visit(node, {
    FragmentSpread: f => {
      names = [...names, f.name.value];
    },
  });

  return names;
};

const getType = (t: TypeInfo) => {
  const type = t.getType() as any;
  return type.ofType || type.toString();
};
