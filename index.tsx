/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classes } from "@utils/misc";
import { ModalContent, ModalRoot, ModalSize, openModal } from "@utils/modal";
import definePlugin from "@utils/types";
import { Message } from "@vencord/discord-types";
import { findByCodeLazy, findByPropsLazy, findComponentByCodeLazy, fluxStores } from "@webpack";
import { Constants, Menu, MessageStore, React, RestAPI, ScrollerThin } from "@webpack/common";
import { ComponentType } from "react";

const messageCache = new Map<string, {
    message?: Message;
    fetched: boolean;
}>();

type MessageComponentProps = {
    compact: boolean;
    channel: any;
    message: Message;
    groupId: string;
    flashKey: any;
    id: string;
    isLastItem: boolean;
    renderContentOnly: boolean;
};
const MessageComponent: ComponentType<MessageComponentProps> = findComponentByCodeLazy(/message:{id:\i}/);
const populateMessagePrototype = findByCodeLazy(/PREMIUM_REFERRAL\?\(\i=\i.default.isProbablyAValidSnowflake\(/);

const chatClasses = findByPropsLazy("messagesWrapper", "scrollerContent", "scrollerInner");
const contentClass = findByPropsLazy("content");

async function getReplyThread(message: Message, thread: Message[] = []): Promise<Message[]> {
    // recursively get the message reference of the message, then get the message reference of that message, etc.
    // until the message reference is null
    let currentMessage: Message | undefined = message;
    while (currentMessage?.messageReference) {
        if (thread.length > 100) break; // i'm sure there's channels out there where people have been replying to a chain since the dawn of time
        thread.push(currentMessage);
        currentMessage = await getOrFetchMessage(currentMessage.messageReference.channel_id, currentMessage.messageReference.message_id);
    }
    if (currentMessage) thread.push(currentMessage);
    if (thread.length > 100 || !currentMessage) return thread; // if we hit the limit, return what we have so far

    // we've now hit a message that isn't a reply to someone, however we can now check a threshold of messages before this message in case someone has sent multiple messages in a row
    // we will check the three messages before this one and if any are replies by the same user as the last message, we will add them to the thread (including intermediate messages by the same user)
    const messagesBefore = await getOrFetchMessagesBefore(currentMessage, 3);

    const currentUserPotential: Message[] = [];
    if (messagesBefore) {
        for (const msg of messagesBefore) {
            if (thread.length > 100) break;
            if (msg.author.id !== currentMessage.author.id) continue;

            // if the message is a reply, add potential thread messages to the thread and then start a new thread search from this message
            if (msg.messageReference) {
                thread.push(...(currentUserPotential.reverse())); // discord returns messages in reverse
                return await getReplyThread(msg, thread);
            } else {
                currentUserPotential.push(msg);
            }
        }
    }

    return thread;
}

async function getOrFetchMessage(channelId: string, messageId: string) {
    const cached = messageCache.get(messageId);
    if (cached && cached?.message) return cached.message;

    const storeMsg = MessageStore.getMessage(channelId, messageId);
    if (storeMsg) return storeMsg;

    messageCache.set(messageId, { fetched: false });

    const res = await RestAPI.get({
        url: Constants.Endpoints.MESSAGES(channelId),
        query: {
            limit: 1,
            around: messageId
        },
        retries: 2
    }).catch(() => null);

    const msg = res?.body?.[0];
    if (!msg) return;

    const message: Message = MessageStore.getMessages(msg.channel_id).receiveMessage(msg).get(msg.id);
    if (!message) return;

    messageCache.set(message.id, {
        message,
        fetched: true
    });

    return message;
}

async function getOrFetchMessagesBefore(message: Message, limit = 3) {
    const messageId = message.id;
    const channelId = message.channel_id;

    const res = await RestAPI.get({
        url: Constants.Endpoints.MESSAGES(channelId),
        query: {
            limit,
            before: messageId
        },
        retries: 2
    }).catch(() => null);

    const msgs = res?.body;
    if (!msgs) return;
    const receivedMessages: Message[] = [];

    for (const msg of msgs) {
        const receivedMessage: Message = MessageStore.getMessages(msg.channel_id).receiveMessage(msg).get(msg.id);
        if (!receivedMessage) continue;

        receivedMessages.push(receivedMessage);

        messageCache.set(receivedMessage.id, {
            message: receivedMessage,
            fetched: true
        });
    }

    if (!receivedMessages.length) return;

    return receivedMessages;
}

export default definePlugin({
    name: "ViewReplyThread",
    description: "Add a button next to replies to view a popup chat containing the thread of replies going back to the original message",
    authors: [{ id: 772601756776923187n, name: "Suffocate" }],

    contextMenus: {
        "message": (children, props) => {
            if (!props.message?.messageReference) return;

            children.push(
                <Menu.MenuItem id={"vc-vrt-view-thread"}
                               label="View Thread"
                               action={async () => {
                                   let messages = await getReplyThread(props.message);
                                   if (messages.length === 0) {
                                       console.log("No messages found");
                                       return;
                                   }

                                   messages = messages.reverse().map(message => {
                                       const cloneMessage = deepClone(message);
                                       delete cloneMessage.messageReference;
                                       cloneMessage.author.hasFlag = () => false; // FIXME: this is a very hacky fix, I need to find how to populate the prototype of the user object
                                       if(props.channel?.guild_id) fluxStores.GuildMemberRequesterStore.requestMember(props.channel?.guild_id, cloneMessage.author.id);
                                       return cloneMessage;
                                   });

                                   openModal(modalProps => {
                                       return (
                                           <ModalRoot {...modalProps} size={ModalSize.LARGE}>
                                               <ModalContent style={{
                                                   display: "flex",
                                                   justifyContent: "center",
                                                   flexDirection: "column"
                                               }} className={classes(chatClasses.scrollerContent, chatClasses.content)}>
                                                   <ScrollerThin
                                                       fade={true}
                                                   >
                                                       <ol className={chatClasses.scrollerInner} style={{
                                                           padding: "32px",
                                                           display: "flex",
                                                           flexDirection: "column",
                                                           gap: "8px"
                                                       }}>
                                                           {messages.map(message => (
                                                               <MessageComponent
                                                                   key={message.id}
                                                                   compact={false}
                                                                   channel={props.channel}
                                                                   message={message}
                                                                   groupId={message.id}
                                                                   id={`chat-messages-${props.channel.id}-${message.id}`}
                                                                   isLastItem={message.id === messages[messages.length - 1].id}
                                                                   renderContentOnly={false}
                                                                   flashKey={undefined}
                                                               />
                                                           ))}
                                                       </ol>
                                                   </ScrollerThin>
                                               </ModalContent>
                                           </ModalRoot>
                                       );
                                   }, {});
                               }}
                />
            );
        }
    },
});

function deepClone(obj: any) {
    if (obj === null || typeof obj !== "object") {
        return obj;
    }

    if (obj instanceof Date) {
        return new Date(obj.getTime());
    }

    if (obj instanceof Array) {
        return obj.map(item => deepClone(item));
    }

    if (obj instanceof Function) {
        const clonedFunc = (...args: any[]) => {
            // @ts-ignore
            return obj.apply(this, args);
        };
        for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                clonedFunc[key] = deepClone(obj[key]);
            }
        }
        return clonedFunc;
    }

    const clonedObj: any = Object.create(Object.getPrototypeOf(obj));
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            clonedObj[key] = deepClone(obj[key]);
        }
    }

    return clonedObj;
}
