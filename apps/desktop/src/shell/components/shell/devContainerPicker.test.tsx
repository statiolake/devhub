// @vitest-environment jsdom

/**
 * The question a folder with a `devcontainer.json` is opened through.
 *
 * The property worth holding is that it is asked *only* of folders that have
 * one. A person who does not use dev containers must never meet this sheet,
 * and a folder that does have a definition must never be built without being
 * asked — building an image is a minute of somebody's time, and spending it
 * because a file exists is DevHub deciding for them.
 *
 * Nothing here reaches docker. The picker asks main two questions and hands
 * the answer back, so a daemon that is not running costs nothing until the
 * person chooses the container.
 */

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PickerValue } from "../../picker/PickerContext";
import { PickerContext } from "../../picker/PickerContext";
import { WorkspacePicker } from "./WorkspacePicker";

Element.prototype.scrollIntoView = vi.fn();
afterEach(cleanup);

const FOLDER = "/projects/api";

function mount(configPath: string | undefined) {
  const devContainerConfig = vi.fn().mockResolvedValue(configPath);
  const openContainerWorkspace = vi.fn().mockResolvedValue(undefined);
  const selectWorkspacePicker = vi.fn().mockResolvedValue(undefined);
  const value = {
    pickerCandidates: [
      { id: FOLDER, path: FOLDER, label: "api", detail: FOLDER },
    ],
    pickerBusy: false,
    pickerSourceCount: 1,
    startWorkspacePicker: vi.fn().mockResolvedValue(undefined),
    cancelWorkspacePicker: vi.fn().mockResolvedValue(undefined),
    selectWorkspacePicker,
    chooseWorkspaceFolder: vi.fn(),
    listSshHosts: vi.fn().mockResolvedValue([]),
    openSshWorkspace: vi.fn(),
    devContainerConfig,
    openContainerWorkspace,
    reportFailure: vi.fn(),
  } as unknown as PickerValue;
  render(
    <PickerContext.Provider value={value}>
      <WorkspacePicker onDismiss={vi.fn()} />
    </PickerContext.Provider>,
  );
  return { devContainerConfig, openContainerWorkspace, selectWorkspacePicker };
}

/** Take the row for the folder, however the list is currently drawn. */
async function chooseFolder() {
  const row = await screen.findByText("api");
  fireEvent.click(row);
}

describe("a folder that defines a Dev Container", () => {
  it("is opened without a question when it defines none", async () => {
    // Nearly every folder. The probe is two `stat`s, so it costs nothing, and
    // the answer "no definition" is the ordinary one — not a failure, and not
    // a reason to show anybody anything.
    const { selectWorkspacePicker, openContainerWorkspace } = mount(undefined);
    await chooseFolder();
    await waitFor(() => {
      expect(selectWorkspacePicker).toHaveBeenCalledWith(
        FOLDER,
        false,
        undefined,
      );
    });
    expect(openContainerWorkspace).not.toHaveBeenCalled();
    expect(screen.queryByText("Open in Dev Container")).not.toBeInTheDocument();
  });

  it("asks which way to open it when it defines one", async () => {
    mount("/projects/api/.devcontainer/devcontainer.json");
    await chooseFolder();
    // Both answers are offered, because neither is wrong: the folder can be
    // worked in here, and the file in it describes somewhere else to work.
    expect(
      await screen.findByText("Open in Dev Container"),
    ).toBeInTheDocument();
    expect(screen.getByText("Open the folder")).toBeInTheDocument();
  });

  it("names the definition it found, so the cost is stated before it is spent", async () => {
    mount("/projects/api/.devcontainer/devcontainer.json");
    await chooseFolder();
    // The first open of a definition that has never been built is an image
    // build, and a person who did not expect one reads a long pause as a hang.
    expect(
      await screen.findByText(
        /Build or start the container .*\.devcontainer\/devcontainer\.json describes/u,
      ),
    ).toBeInTheDocument();
  });

  it("builds the container only when that is the answer given", async () => {
    const { openContainerWorkspace, selectWorkspacePicker } = mount(
      "/projects/api/.devcontainer.json",
    );
    await chooseFolder();
    fireEvent.click(await screen.findByText("Open in Dev Container"));
    await waitFor(() => {
      expect(openContainerWorkspace).toHaveBeenCalledWith(FOLDER, undefined);
    });
    expect(selectWorkspacePicker).not.toHaveBeenCalled();
  });

  it("opens the folder here when that is the answer given", async () => {
    const { openContainerWorkspace, selectWorkspacePicker } = mount(
      "/projects/api/.devcontainer.json",
    );
    await chooseFolder();
    fireEvent.click(await screen.findByText("Open the folder"));
    await waitFor(() => {
      expect(selectWorkspacePicker).toHaveBeenCalledWith(
        FOLDER,
        false,
        undefined,
      );
    });
    // The definition is still there and still not built. Choosing to work here
    // is not choosing to spend a minute building an image.
    expect(openContainerWorkspace).not.toHaveBeenCalled();
  });
});
