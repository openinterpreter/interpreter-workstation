import { TreeProps } from "../types/tree-props";
import { useSimpleTree } from "./use-simple-tree";

const EMPTY_INITIAL_DATA: readonly unknown[] = [];

export function useValidatedProps<T>(props: TreeProps<T>): TreeProps<T> {
  const [data, controller] = useSimpleTree<T>(
    props.initialData ?? (EMPTY_INITIAL_DATA as readonly T[])
  );

  if (props.initialData && props.data) {
    throw new Error(
      `React Arborist Tree => Provide either a data or initialData prop, but not both.`
    );
  }
  if (
    props.initialData &&
    (props.onCreate || props.onDelete || props.onMove || props.onRename)
  ) {
    throw new Error(
      `React Arborist Tree => You passed the initialData prop along with a data handler.
Use the data prop if you want to provide your own handlers.`
    );
  }
  if (props.initialData) {
    return { ...props, ...controller, data };
  } else {
    return props;
  }
}
