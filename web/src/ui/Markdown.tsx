import React from 'react';
import {MarkdownText} from './markdown/MarkdownText.tsx';
export const markdownLabels={code:{copyLabel:'Copy',copiedLabel:'Copied'},footnotes:'Footnotes'};
export function Markdown({text,streaming=false}:{text:string;streaming?:boolean}){return <MarkdownText text={text} streaming={streaming} labels={markdownLabels}/>;}
